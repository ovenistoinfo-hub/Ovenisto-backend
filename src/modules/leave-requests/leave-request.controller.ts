import type { Request, Response } from 'express';
import { prisma } from '../../config/database.js';
import { ApiResponse } from '../../utils/ApiResponse.js';
import { ApiError } from '../../utils/ApiError.js';
import { asyncHandler } from '../../utils/asyncHandler.js';
import { resolveOutletScope, resolveCreateOutlet } from '../../middleware/outletScope.js';

const adminRoles = ['Super Admin', 'Admin', 'Manager'];

function currentYear(): number {
  return new Date(Date.now() + 5 * 60 * 60 * 1000).getFullYear();
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
  const scope = resolveOutletScope(req);

  const where: any = { year };
  if (scope) where.user = { outletId: scope };

  const balances = await prisma.leaveBalance.findMany({
    where,
    include: { user: { select: { id: true, name: true, role: true, outletId: true } } },
    orderBy: { user: { name: 'asc' } },
  });

  return res.json(ApiResponse.success(balances));
});

export const updateBalance = asyncHandler(async (req: Request, res: Response) => {
  const { userId } = req.params;
  const year = currentYear();
  const { annual, sick, casual, halfday } = req.body;

  const balance = await prisma.leaveBalance.upsert({
    where: { userId_year: { userId, year } },
    update: {
      ...(annual != null ? { annual: Number(annual) } : {}),
      ...(sick   != null ? { sick:   Number(sick)   } : {}),
      ...(casual != null ? { casual: Number(casual) } : {}),
      ...(halfday != null ? { halfday: Number(halfday) } : {}),
    },
    create: {
      userId,
      year,
      annual: annual != null ? Number(annual) : 14,
      sick:   sick   != null ? Number(sick)   : 6,
      casual: casual != null ? Number(casual) : 6,
      halfday: halfday != null ? Number(halfday) : 10,
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

  const start = new Date(startDate + 'T00:00:00Z');
  const end   = new Date(endDate + 'T00:00:00Z');
  if (end < start) throw new ApiError('endDate must be >= startDate', 400);

  const diffMs = Math.abs(end.getTime() - start.getTime());
  const totalDays = Math.round(diffMs / (24 * 60 * 60 * 1000)) + 1;

  const userId = req.user!.id;
  if (leaveType !== 'emergency') {
    const balance = await prisma.leaveBalance.upsert({
      where: { userId_year: { userId, year: currentYear() } },
      update: {},
      create: { userId, year: currentYear() },
    });
    const usedField = `${leaveType}Used` as 'annualUsed' | 'sickUsed' | 'casualUsed';
    const totalField = leaveType as 'annual' | 'sick' | 'casual';
    if (usedField in { annualUsed: 1, sickUsed: 1, casualUsed: 1 }) {
      const used = balance[usedField] as number;
      const total = balance[totalField] as number;
      const remaining = Math.max(0, total - used);
      if (remaining <= 0) {
        throw new ApiError(
          `You have exhausted your ${leaveType} leave balance (0 days left).`,
          400,
        );
      }
      if (totalDays > remaining) {
        throw new ApiError(
          `Insufficient ${leaveType} leave balance (only ${remaining} day${remaining === 1 ? '' : 's'} left, but requested ${totalDays} days).`,
          400,
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
      const totalField = existing.leaveType as 'annual' | 'sick' | 'casual';
      if (field in { annualUsed: 1, sickUsed: 1, casualUsed: 1 }) {
        const bal = await tx.leaveBalance.upsert({
          where: { userId_year: { userId: existing.userId, year } },
          update: {},
          create: { userId: existing.userId, year },
        });
        const currentUsed = bal[field] as number;
        const totalAllowed = bal[totalField] as number;
        const newUsed = Math.min(totalAllowed, currentUsed + existing.totalDays);
        await tx.leaveBalance.update({
          where: { id: bal.id },
          data: { [field]: newUsed },
        });
      }

      // Sync employee schedule shifts to 'off' for the entire approved leave period
      const startMs = new Date(`${existing.startDate}T00:00:00Z`).getTime();
      const endMs = new Date(`${existing.endDate}T00:00:00Z`).getTime();
      let curMs = startMs;
      const daysToOff: { weekStart: string; dayIndex: number }[] = [];

      while (curMs <= endMs) {
        const curDate = new Date(curMs);
        const day = curDate.getUTCDay(); // 0=Sun..6=Sat
        const diff = day === 0 ? -6 : 1 - day;
        const mondayMs = curMs + diff * 86_400_000;
        const weekStart = new Date(mondayMs).toISOString().split('T')[0];
        const dayIndex = day === 0 ? 6 : day - 1;

        daysToOff.push({ weekStart, dayIndex });
        curMs += 86_400_000;
      }

      const byWeek: Record<string, number[]> = {};
      for (const item of daysToOff) {
        if (!byWeek[item.weekStart]) byWeek[item.weekStart] = [];
        if (!byWeek[item.weekStart].includes(item.dayIndex)) {
          byWeek[item.weekStart].push(item.dayIndex);
        }
      }

      for (const [wStart, dayIndices] of Object.entries(byWeek)) {
        const schedule = await tx.staffSchedule.findFirst({
          where: { userId: existing.userId, weekStart: wStart },
        });

        if (!schedule) {
          const createdSched = await tx.staffSchedule.create({
            data: {
              userId: existing.userId,
              outletId: existing.outletId,
              weekStart: wStart,
              status: 'published',
            },
          });
          const defaultShifts = Array.from({ length: 7 }, (_, i) => ({
            scheduleId: createdSched.id,
            dayIndex: i,
            shiftType: 'off',
            startTime: null,
            endTime: null,
          }));
          await tx.scheduleShift.createMany({ data: defaultShifts });
        } else {
          await tx.scheduleShift.updateMany({
            where: { scheduleId: schedule.id, dayIndex: { in: dayIndices } },
            data: { shiftType: 'off', startTime: null, endTime: null },
          });
        }
      }
    }

    return updated_;
  });

  return res.json(ApiResponse.success(updated, `Leave request ${newStatus}`));
});
