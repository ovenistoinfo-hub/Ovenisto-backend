import type { Request, Response } from 'express';
import { prisma } from '../../config/database.js';
import { ApiResponse } from '../../utils/ApiResponse.js';
import { ApiError } from '../../utils/ApiError.js';
import { asyncHandler } from '../../utils/asyncHandler.js';
import { resolveOutletScope } from '../../middleware/outletScope.js';
import { executeCancellation, validateCancellationTargets, mapOrderOut } from '../order/order.controller.js';
import { emitOrderEvent, emitCancellationRequestEvent } from '../../socket.js';

// Fetched via prisma.user.findUnique — Prisma returns the raw UserRole enum member
// (e.g. 'SUPER_ADMIN'), NOT the @map'd display string. req.user!.role (from the JWT,
// mapped at login) is the display string ('Super Admin'). Two lists, two sources —
// see the outlet-scoping / enum gotcha in CLAUDE.md.
const AUTHORIZER_ENUM_ROLES = ['SUPER_ADMIN', 'ADMIN', 'MANAGER'];
const AUTHORIZER_DISPLAY_ROLES = ['Super Admin', 'Admin', 'Manager'];

function todayPKT(): string {
  const pkt = new Date(Date.now() + 5 * 60 * 60 * 1000);
  return pkt.toISOString().split('T')[0];
}

const includeShape = {
  order: {
    select: {
      id: true, orderNumber: true, total: true, status: true,
      customerName: true, date: true, time: true,
    },
  },
  requestedBy: { select: { id: true, name: true } },
  approver: { select: { id: true, name: true } },
  responsibleUser: { select: { id: true, name: true } },
  reviewedBy: { select: { id: true, name: true } },
} as const;

function mapRequestOut(r: any) {
  return {
    ...r,
    refundAmount: Number(r.refundAmount),
    newSubtotal: r.newSubtotal != null ? Number(r.newSubtotal) : null,
    newTax: r.newTax != null ? Number(r.newTax) : null,
    newTotal: r.newTotal != null ? Number(r.newTotal) : null,
    penaltyAmount: Number(r.penaltyAmount),
    order: r.order ? { ...r.order, total: Number(r.order.total) } : r.order,
  };
}

/**
 * Runs the approve transaction: re-validates the order is still cancellable, executes
 * the shared cancellation mutation, writes a StaffPenalty if applicable, and marks the
 * request approved. Shared by the review endpoint and the requester's own
 * auto-approve convenience path.
 */
async function approveRequest(
  requestId: string,
  reviewerId: string,
  reviewerName: string | null,
  overridePenaltyAmount: number | undefined,
  overrideResponsibleUserId: string | null | undefined,
  reviewNote: string | null | undefined,
) {
  return prisma.$transaction(async (tx) => {
    const request = await tx.orderCancellationRequest.findUnique({ where: { id: requestId } });
    if (!request) throw ApiError.notFound('Cancellation request not found');
    if (request.status !== 'pending') throw ApiError.badRequest('Only pending requests can be reviewed');

    const order = await tx.order.findUnique({ where: { id: request.orderId }, include: { items: true } });
    if (!order) throw ApiError.notFound('Order not found');
    if (order.status === 'COMPLETED' || order.status === 'CANCELLED') {
      throw ApiError.badRequest('Order cannot be cancelled from its current status');
    }

    const finalPenaltyAmount = overridePenaltyAmount ?? Number(request.penaltyAmount);
    const finalResponsibleUserId = overrideResponsibleUserId !== undefined
      ? overrideResponsibleUserId
      : request.responsibleUserId;

    let responsibleUserName: string | null = null;
    if (finalResponsibleUserId) {
      const respUser = await tx.user.findUnique({ where: { id: finalResponsibleUserId }, select: { name: true } });
      if (!respUser) throw ApiError.badRequest('Selected responsible person not found');
      responsibleUserName = respUser.name;
    }

    const cancelledOrder = await executeCancellation(tx, {
      existing: order,
      itemIds: request.itemIds.length > 0 ? request.itemIds : undefined,
      reason: request.reason,
      refundAmount: Number(request.refundAmount),
      refundMethod: request.refundMethod,
      newSubtotal: request.newSubtotal != null ? Number(request.newSubtotal) : undefined,
      newTax: request.newTax != null ? Number(request.newTax) : undefined,
      newTotal: request.newTotal != null ? Number(request.newTotal) : undefined,
      authorizedById: reviewerId,
      actingUserName: reviewerName,
      penaltyAmount: finalPenaltyAmount,
      responsibleUserName,
    });

    if (finalPenaltyAmount > 0 && finalResponsibleUserId) {
      await tx.staffPenalty.create({
        data: {
          userId: finalResponsibleUserId,
          outletId: request.outletId,
          amount: finalPenaltyAmount,
          reason: `Order ${cancelledOrder.orderNumber} cancelled — ${request.reason}`,
          type: 'order_cancellation',
          date: todayPKT(),
          orderId: request.orderId,
          requestId: request.id,
        },
      });
    }

    const updatedRequest = await tx.orderCancellationRequest.update({
      where: { id: requestId },
      data: {
        status: 'approved',
        reviewedById: reviewerId,
        reviewedAt: new Date(),
        reviewNote: reviewNote || null,
        penaltyAmount: finalPenaltyAmount,
        responsibleUserId: finalResponsibleUserId,
      },
      include: includeShape,
    });

    return { updatedRequest, cancelledOrder };
  }, { timeout: 60000 });
}

/** POST /api/orders/:id/cancellation-requests */
export const createCancellationRequest = asyncHandler(async (req: Request, res: Response) => {
  const { id } = req.params;
  const {
    itemIds, reason, approverId, responsibleUserId, penaltyAmount,
    refundAmount, refundMethod, newSubtotal, newTax, newTotal, autoApprove,
  } = req.body;

  if (!reason) throw ApiError.badRequest('Reason is required');
  if (!approverId) throw ApiError.badRequest('Approver is required');
  if (refundAmount == null) throw ApiError.badRequest('Refund amount is required');
  if (!refundMethod) throw ApiError.badRequest('Refund method is required');
  if (typeof refundAmount !== 'number' || refundAmount < 0) {
    throw ApiError.badRequest('Refund amount must be a non-negative number');
  }
  if (!['cash', 'card', 'online', 'none'].includes(refundMethod)) {
    throw ApiError.badRequest('Invalid refund method');
  }
  if (penaltyAmount != null && (typeof penaltyAmount !== 'number' || penaltyAmount < 0)) {
    throw ApiError.badRequest('Penalty amount must be a non-negative number');
  }

  const existing = await prisma.order.findUnique({ where: { id }, include: { items: true } });
  if (!existing) throw ApiError.notFound('Order not found');
  const scope = resolveOutletScope(req);
  if (scope && existing.outletId !== scope) throw ApiError.notFound('Order not found');

  if (existing.status === 'COMPLETED' || existing.status === 'CANCELLED') {
    throw ApiError.badRequest('Order cannot be cancelled from its current status');
  }

  const approver = await prisma.user.findUnique({ where: { id: approverId } });
  if (!approver || !AUTHORIZER_ENUM_ROLES.includes(approver.role)) {
    throw ApiError.badRequest('Selected approver is not authorized to approve cancellations');
  }

  if (responsibleUserId) {
    const responsibleUser = await prisma.user.findUnique({ where: { id: responsibleUserId }, select: { id: true } });
    if (!responsibleUser) throw ApiError.badRequest('Selected responsible person not found');
  }

  const activeItems = existing.items.filter((i) => i.status !== 'cancelled');
  validateCancellationTargets(activeItems, itemIds, newSubtotal, newTax, newTotal);

  const request = await prisma.orderCancellationRequest.create({
    data: {
      orderId: id,
      outletId: existing.outletId,
      itemIds: Array.isArray(itemIds) ? itemIds : [],
      reason,
      refundAmount,
      refundMethod,
      newSubtotal, newTax, newTotal,
      requestedById: req.user!.id,
      approverId,
      responsibleUserId: responsibleUserId || null,
      penaltyAmount: penaltyAmount ?? 0,
    },
    include: includeShape,
  });

  // Convenience: a manager/admin filing their own request can skip the separate
  // approval step by opting into autoApprove.
  if (autoApprove === true && AUTHORIZER_DISPLAY_ROLES.includes(req.user!.role)) {
    const { updatedRequest, cancelledOrder } = await approveRequest(
      request.id, req.user!.id, req.user!.name ?? null, undefined, undefined, 'Auto-approved by requester',
    );
    const mappedOrder = mapOrderOut(cancelledOrder);
    emitOrderEvent('order:updated', mappedOrder);
    emitCancellationRequestEvent('cancellationRequest:updated', mapRequestOut(updatedRequest));
    return res.status(201).json(ApiResponse.created(mapRequestOut(updatedRequest), 'Order cancelled'));
  }

  emitCancellationRequestEvent('cancellationRequest:created', mapRequestOut(request));
  return res.status(201).json(ApiResponse.created(mapRequestOut(request), 'Cancellation request sent for approval'));
});

/** GET /api/cancellation-requests */
export const listCancellationRequests = asyncHandler(async (req: Request, res: Response) => {
  const { status } = req.query as { status?: string };
  const scope = resolveOutletScope(req);

  const where: Record<string, unknown> = {};
  if (scope) where.outletId = scope;
  if (status) where.status = status;

  const requests = await prisma.orderCancellationRequest.findMany({
    where,
    include: includeShape,
    orderBy: { createdAt: 'desc' },
  });

  res.json(ApiResponse.success(requests.map(mapRequestOut)));
});

/** GET /api/cancellation-requests/mine */
export const listMyCancellationRequests = asyncHandler(async (req: Request, res: Response) => {
  const requests = await prisma.orderCancellationRequest.findMany({
    where: { requestedById: req.user!.id },
    include: includeShape,
    orderBy: { createdAt: 'desc' },
  });

  res.json(ApiResponse.success(requests.map(mapRequestOut)));
});

/** PATCH /api/cancellation-requests/:id/review */
export const reviewCancellationRequest = asyncHandler(async (req: Request, res: Response) => {
  const { id } = req.params;
  const { action, penaltyAmount, responsibleUserId, note } = req.body;

  if (!action || !['approve', 'reject'].includes(action)) {
    throw ApiError.badRequest('action must be "approve" or "reject"');
  }

  const existing = await prisma.orderCancellationRequest.findUnique({ where: { id } });
  if (!existing) throw ApiError.notFound('Cancellation request not found');
  const scope = resolveOutletScope(req);
  if (scope && existing.outletId !== scope) throw ApiError.notFound('Cancellation request not found');
  if (existing.status !== 'pending') throw ApiError.badRequest('Only pending requests can be reviewed');

  if (action === 'reject') {
    const rejected = await prisma.orderCancellationRequest.update({
      where: { id },
      data: {
        status: 'rejected',
        reviewedById: req.user!.id,
        reviewedAt: new Date(),
        reviewNote: note || null,
      },
      include: includeShape,
    });
    emitCancellationRequestEvent('cancellationRequest:updated', mapRequestOut(rejected));
    return res.json(ApiResponse.success(mapRequestOut(rejected), 'Cancellation request rejected'));
  }

  if (penaltyAmount != null && (typeof penaltyAmount !== 'number' || penaltyAmount < 0)) {
    throw ApiError.badRequest('Penalty amount must be a non-negative number');
  }

  const { updatedRequest, cancelledOrder } = await approveRequest(
    id, req.user!.id, req.user!.name ?? null, penaltyAmount, responsibleUserId, note,
  );

  const mappedOrder = mapOrderOut(cancelledOrder);
  emitOrderEvent('order:updated', mappedOrder);
  emitCancellationRequestEvent('cancellationRequest:updated', mapRequestOut(updatedRequest));
  return res.json(ApiResponse.success(mapRequestOut(updatedRequest), 'Cancellation request approved'));
});
