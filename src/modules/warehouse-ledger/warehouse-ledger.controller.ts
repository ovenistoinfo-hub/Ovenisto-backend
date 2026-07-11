/**
 * Warehouse Ledger Controller — per-branch running balance owed to the
 * central Main warehouse for received stock transfers, plus its payment history.
 */
import type { Request, Response } from 'express';
import { prisma } from '../../config/database.js';
import { ApiResponse } from '../../utils/ApiResponse.js';
import { ApiError } from '../../utils/ApiError.js';
import { asyncHandler } from '../../utils/asyncHandler.js';
import { USER_SELECT, mapUser } from '../../utils/userHelpers.js';
import { resolveOutletScope } from '../../middleware/outletScope.js';

function mapSettlement(s: any) {
  return {
    id: s.id,
    outletId: s.outletId,
    type: s.type,
    amount: Number(s.amount),
    balanceAfter: Number(s.balanceAfter),
    challanId: s.challanId ?? null,
    challanNo: s.challan?.challanNo ?? null,
    notes: s.notes ?? null,
    recordedBy: mapUser(s.recordedBy),
    createdAt: s.createdAt,
  };
}

// Non-Super-Admin callers may only ever act on their own outlet — mirrors every
// other by-id handler's 404-not-403 convention (never reveal existence of another outlet's row).
function assertOutletInScope(req: Request, outletId: string): void {
  const scope = resolveOutletScope(req);
  if (scope && outletId !== scope) throw new ApiError('Outlet not found', 404);
}

export const getLedgerSummary = asyncHandler(async (req: Request, res: Response) => {
  const scope = resolveOutletScope(req);
  const where = scope ? { id: scope } : {};
  const outlets = await prisma.outlet.findMany({
    where,
    select: { id: true, name: true, code: true, dueToMain: true },
    orderBy: { name: 'asc' },
  });
  const data = outlets.map((o) => ({ id: o.id, name: o.name, code: o.code, dueToMain: Number(o.dueToMain) }));
  const chainTotal = data.reduce((sum, o) => sum + o.dueToMain, 0);
  return res.json({ ...ApiResponse.success(data), chainTotal });
});

export const getSettlements = asyncHandler(async (req: Request, res: Response) => {
  assertOutletInScope(req, req.params.outletId);
  const { page = '1', limit = '20' } = req.query as Record<string, string>;
  const skip = (Number(page) - 1) * Number(limit);

  const [data, total] = await Promise.all([
    prisma.warehouseSettlement.findMany({
      where: { outletId: req.params.outletId },
      include: { recordedBy: { select: USER_SELECT }, challan: { select: { challanNo: true } } },
      orderBy: { createdAt: 'desc' },
      skip,
      take: Number(limit),
    }),
    prisma.warehouseSettlement.count({ where: { outletId: req.params.outletId } }),
  ]);

  return res.json(ApiResponse.paginated(data.map(mapSettlement), Number(page), Number(limit), total));
});

export const createSettlement = asyncHandler(async (req: Request, res: Response) => {
  assertOutletInScope(req, req.params.outletId);
  const { amount, notes } = req.body;
  const amountNum = Number(amount);
  if (!amountNum || amountNum <= 0) throw new ApiError('Amount must be greater than 0', 400);

  const outlet = await prisma.outlet.findUnique({ where: { id: req.params.outletId }, select: { dueToMain: true } });
  if (!outlet) throw new ApiError('Outlet not found', 404);
  if (amountNum > Number(outlet.dueToMain)) {
    throw new ApiError(`Amount exceeds outstanding balance (Rs. ${Number(outlet.dueToMain).toFixed(2)})`, 400);
  }

  const settlement = await prisma.$transaction(async (tx) => {
    const updatedOutlet = await tx.outlet.update({
      where: { id: req.params.outletId },
      data: { dueToMain: { decrement: amountNum } },
    });
    return tx.warehouseSettlement.create({
      data: {
        outletId: req.params.outletId,
        type: 'PAYMENT',
        amount: amountNum,
        balanceAfter: updatedOutlet.dueToMain,
        notes: notes || null,
        recordedById: req.user?.id || null,
      },
      include: { recordedBy: { select: USER_SELECT }, challan: { select: { challanNo: true } } },
    });
  });

  return res.status(201).json(ApiResponse.created(mapSettlement(settlement), 'Payment recorded'));
});
