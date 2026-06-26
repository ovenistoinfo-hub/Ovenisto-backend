import type { Request, Response } from 'express';
import { prisma } from '../../config/database.js';
import { ApiResponse } from '../../utils/ApiResponse.js';
import { ApiError } from '../../utils/ApiError.js';
import { asyncHandler } from '../../utils/asyncHandler.js';
import { resolveOutletScope, resolveCreateOutlet } from '../../middleware/outletScope.js';

const adminRoles = ['Super Admin', 'Admin', 'Manager'];

function currentYear(): number {
  return new Date().getFullYear();
}

function todayStr(): string {
  // Use PKT (UTC+5) so midnight shifts stamp the correct local date
  const pkt = new Date(Date.now() + 5 * 60 * 60 * 1000);
  return pkt.toISOString().split('T')[0];
}

export const getMyBalance = asyncHandler(async (req: Request, res: Response) => {
  const userId = req.user!.id;
  const year = currentYear();

  const balance = await prisma.leaveBalance.upsert({
    where: { userId_year: { userId, year } },
    update: {},
    create: { userId, year },
  });

  return res.json(ApiResponse.success(balance));
});

export const getAllBalances = asyncHandler(async (req: Request, res: Response) => {
  const year = currentYear();

  const balances = await prisma.leaveBalance.findMany({
    where: { year },
    include: { user: { select: { id: true, name: true, role: true } } },
    orderBy: { user: { name: 'asc' } },
  });

  return res.json(ApiResponse.success(balances));
});

export const updateBalance = asyncHandler(async (req: Request, res: Response) => {
  const { userId } = req.params;
  const year = currentYear();
  const { annual, sick, casual } = req.body;

  const balance = await prisma.leaveBalance.upsert({
    where: { userId_year: { userId, year } },
    update: {
      ...(annual != null ? { annual: Number(annual) } : {}),
      ...(sick   != null ? { sick:   Number(sick)   } : {}),
      ...(casual != null ? { casual: Number(casual) } : {}),
    },
    create: {
      userId,
      year,
      annual: annual != null ? Number(annual) : 14,
      sick:   sick   != null ? Number(sick)   : 6,
      casual: casual != null ? Number(casual) : 6,
    },
  });

  return res.json(ApiResponse.success(balance, 'Balance updated'));
});

export const getLeaveRequests = asyncHandler(async (req: Request, res: Response) => {
  const { status, userId: filterUserId } = req.query as Record<string, string>;
  const role = req.user!.role;
  const isAdmin = adminRoles.includes(role);

  const where: Record<string, unknown> = {};
  if (!isAdmin) {
    where.userId = req.user!.id;
  } else {
    if (filterUserId) where.userId = filterUserId;
    const scope = resolveOutletScope(req);
    if (scope) where.outletId = scope;
  }
  if (status) where.status = status;

  const data = await prisma.leaveRequest.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    include: {
      user: { select: { id: true, name: true, role: true } },
      reviewedBy: { select: { id: true, name: true } },
    },
  });

  return res.json(ApiResponse.success(data));
});

export const submitLeaveRequest = asyncHandler(async (req: Request, res: Response) => {
  const { leaveType, startDate, endDate, reason } = req.body;
  if (!leaveType || !startDate || !endDate || !reason) {
    throw new ApiError('leaveType, startDate, endDate, reason are required', 400);
  }

  const validTypes = ['casual', 'sick', 'annual', 'emergency'];
  if (!validTypes.includes(leaveType)) throw new ApiError('Invalid leave type', 400);

  const start = new Date(startDate);
  const end   = new Date(endDate);
  if (end < start) throw new ApiError('endDate must be >= startDate', 400);

  let totalDays = 0;
  const d = new Date(start);
  while (d <= end) {
    const day = d.getDay();
    if (day !== 0 && day !== 6) totalDays++;
    d.setDate(d.getDate() + 1);
  }
  if (totalDays === 0) totalDays = 1;

  const userId = req.user!.id;
  if (leaveType !== 'emergency') {
    const balance = await prisma.leaveBalance.findUnique({
      where: { userId_year: { userId, year: currentYear() } },
    });
    if (balance) {
      const used  = balance[`${leaveType}Used` as keyof typeof balance] as number;
      const total = balance[leaveType as keyof typeof balance] as number;
      if (used + totalDays > total) {
        throw new ApiError(
          `Insufficient ${leaveType} leave balance (${total - used} days left)`,
          400
        );
      }
    }
  }

  const outletId = resolveCreateOutlet(req);

  const request = await prisma.leaveRequest.create({
    data: {
      userId,
      outletId,
      leaveType,
      startDate,
      endDate,
      totalDays,
      reason,
      appliedOn: todayStr(),
    },
  });

  return res.status(201).json(ApiResponse.created(request, 'Leave request submitted'));
});

export const cancelLeaveRequest = asyncHandler(async (req: Request, res: Response) => {
  const existing = await prisma.leaveRequest.findUnique({ where: { id: req.params.id } });
  if (!existing) throw new ApiError('Leave request not found', 404);
  if (existing.userId !== req.user!.id) throw new ApiError('Leave request not found', 404);
  if (existing.status !== 'pending') throw new ApiError('Only pending requests can be cancelled', 400);

  await prisma.leaveRequest.delete({ where: { id: req.params.id } });
  return res.json(ApiResponse.success(null, 'Leave request cancelled'));
});

export const reviewLeaveRequest = asyncHandler(async (req: Request, res: Response) => {
  const { action, reviewNote } = req.body;
  if (!action || !['approve', 'reject'].includes(action)) {
    throw new ApiError('action must be "approve" or "reject"', 400);
  }

  const existing = await prisma.leaveRequest.findUnique({ where: { id: req.params.id } });
  if (!existing) throw new ApiError('Leave request not found', 404);

  const scope = resolveOutletScope(req);
  if (scope && existing.outletId !== scope) throw new ApiError('Leave request not found', 404);

  if (existing.status !== 'pending') throw new ApiError('Only pending requests can be reviewed', 400);

  const newStatus = action === 'approve' ? 'approved' : 'rejected';

  const updated = await prisma.$transaction(async (tx) => {
    const updated_ = await tx.leaveRequest.update({
      where: { id: existing.id },
      data: {
        status: newStatus,
        reviewedById: req.user!.id,
        reviewedOn: todayStr(),
        reviewNote: reviewNote || null,
      },
    });

    if (action === 'approve') {
      const year = currentYear();
      const field = `${existing.leaveType}Used` as 'annualUsed' | 'sickUsed' | 'casualUsed';
      if (field in { annualUsed: 1, sickUsed: 1, casualUsed: 1 }) {
        await tx.leaveBalance.upsert({
          where: { userId_year: { userId: existing.userId, year } },
          update: { [field]: { increment: existing.totalDays } },
          create: { userId: existing.userId, year, [field]: existing.totalDays },
        });
      }
    }

    return updated_;
  });

  return res.json(ApiResponse.success(updated, `Leave request ${newStatus}`));
});
