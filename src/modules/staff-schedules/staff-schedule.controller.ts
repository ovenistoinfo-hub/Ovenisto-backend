import type { Request, Response } from 'express';
import { prisma } from '../../config/database.js';
import { ApiResponse } from '../../utils/ApiResponse.js';
import { ApiError } from '../../utils/ApiError.js';
import { asyncHandler } from '../../utils/asyncHandler.js';
import { resolveOutletScope, resolveCreateOutlet } from '../../middleware/outletScope.js';

const SHIFT_TEMPLATES: Record<string, { startTime: string | null; endTime: string | null }> = {
  morning: { startTime: '09:00', endTime: '17:00' },
  evening: { startTime: '17:00', endTime: '01:00' },
  night:   { startTime: '01:00', endTime: '09:00' },
  off:     { startTime: null,    endTime: null    },
};

export const getMySchedule = asyncHandler(async (req: Request, res: Response) => {
  const { week } = req.query as Record<string, string>;
  if (!week) throw new ApiError('week query param required (YYYY-MM-DD Monday)', 400);

  const schedule = await prisma.staffSchedule.findFirst({
    where: { userId: req.user!.id, weekStart: week },
    include: { shifts: { orderBy: { dayIndex: 'asc' } } },
  });

  return res.json(ApiResponse.success(schedule));
});

export const getAllSchedules = asyncHandler(async (req: Request, res: Response) => {
  const { weekStart, userId } = req.query as Record<string, string>;
  const where: any = {};
  if (weekStart) where.weekStart = weekStart;
  if (userId)    where.userId    = userId;

  const scope = resolveOutletScope(req);
  if (scope) where.outletId = scope;

  const schedules = await prisma.staffSchedule.findMany({
    where,
    include: {
      shifts:  { orderBy: { dayIndex: 'asc' } },
      user:    { select: { id: true, name: true, role: true } },
    },
    orderBy: [{ weekStart: 'desc' }, { user: { name: 'asc' } }],
  });

  return res.json(ApiResponse.success(schedules));
});

export const saveSchedule = asyncHandler(async (req: Request, res: Response) => {
  const { userId, weekStart, shifts } = req.body;
  if (!userId || !weekStart || !Array.isArray(shifts)) {
    throw new ApiError('userId, weekStart, and shifts[] are required', 400);
  }

  const outletId = resolveCreateOutlet(req);

  const schedule = await prisma.$transaction(async (tx) => {
    const existing = await tx.staffSchedule.findFirst({
      where: { userId, weekStart },
    });

    if (existing) {
      const scope = resolveOutletScope(req);
      if (scope && existing.outletId !== scope) throw new ApiError('Schedule not found', 404);
      await tx.scheduleShift.deleteMany({ where: { scheduleId: existing.id } });
      await tx.staffSchedule.update({
        where: { id: existing.id },
        data: { status: 'draft', updatedAt: new Date() },
      });
      await tx.scheduleShift.createMany({
        data: shifts.map((s: any) => ({
          scheduleId: existing.id,
          dayIndex: Number(s.dayIndex),
          shiftType: s.shiftType,
          startTime: SHIFT_TEMPLATES[s.shiftType]?.startTime ?? null,
          endTime:   SHIFT_TEMPLATES[s.shiftType]?.endTime   ?? null,
        })),
      });
      return tx.staffSchedule.findUnique({
        where: { id: existing.id },
        include: { shifts: { orderBy: { dayIndex: 'asc' } } },
      });
    } else {
      const created = await tx.staffSchedule.create({
        data: { userId, outletId, weekStart, status: 'draft' },
      });
      await tx.scheduleShift.createMany({
        data: shifts.map((s: any) => ({
          scheduleId: created.id,
          dayIndex: Number(s.dayIndex),
          shiftType: s.shiftType,
          startTime: SHIFT_TEMPLATES[s.shiftType]?.startTime ?? null,
          endTime:   SHIFT_TEMPLATES[s.shiftType]?.endTime   ?? null,
        })),
      });
      return tx.staffSchedule.findUnique({
        where: { id: created.id },
        include: { shifts: { orderBy: { dayIndex: 'asc' } } },
      });
    }
  });

  return res.status(201).json(ApiResponse.created(schedule, 'Schedule saved'));
});

export const publishSchedule = asyncHandler(async (req: Request, res: Response) => {
  const existing = await prisma.staffSchedule.findUnique({ where: { id: req.params.id } });
  if (!existing) throw new ApiError('Schedule not found', 404);

  const scope = resolveOutletScope(req);
  if (scope && existing.outletId !== scope) throw new ApiError('Schedule not found', 404);

  const updated = await prisma.staffSchedule.update({
    where: { id: req.params.id },
    data: { status: 'published' },
    include: { shifts: { orderBy: { dayIndex: 'asc' } } },
  });

  return res.json(ApiResponse.success(updated, 'Schedule published'));
});

export const deleteSchedule = asyncHandler(async (req: Request, res: Response) => {
  const existing = await prisma.staffSchedule.findUnique({ where: { id: req.params.id } });
  if (!existing) throw new ApiError('Schedule not found', 404);

  const scope = resolveOutletScope(req);
  if (scope && existing.outletId !== scope) throw new ApiError('Schedule not found', 404);

  await prisma.staffSchedule.delete({ where: { id: req.params.id } });
  return res.json(ApiResponse.success(null, 'Schedule deleted'));
});
