import type { Request, Response } from 'express';
import { z } from 'zod';
import { prisma } from '../../config/database.js';
import { ApiResponse } from '../../utils/ApiResponse.js';
import { ApiError } from '../../utils/ApiError.js';
import { asyncHandler } from '../../utils/asyncHandler.js';
import { resolveOutletScope, resolveCreateOutlet } from '../../middleware/outletScope.js';

function todayStr(): string {
  // Use PKT (UTC+5) so midnight shifts stamp the correct local date
  const pkt = new Date(Date.now() + 5 * 60 * 60 * 1000);
  return pkt.toISOString().split('T')[0];
}

function currentWeekStart(): string {
  const now = new Date();
  const day = now.getDay();
  const diff = now.getDate() - day + (day === 0 ? -6 : 1);
  const d = new Date(now);
  d.setDate(diff);
  d.setUTCHours(0, 0, 0, 0);
  return d.toISOString().split('T')[0];
}

function todayDayIndex(): number {
  const day = new Date().getDay();
  return day === 0 ? 6 : day - 1;
}

export const clockIn = asyncHandler(async (req: Request, res: Response) => {
  const userId = req.user!.id;
  const date = todayStr();

  const existing = await prisma.attendanceRecord.findUnique({
    where: { userId_date: { userId, date } },
  });
  if (existing?.clockIn) throw new ApiError('Already clocked in today', 400);

  const outletId = resolveCreateOutlet(req);
  const now = new Date();

  const record = existing
    ? await prisma.attendanceRecord.update({
        where: { id: existing.id },
        data: { clockIn: now },
      })
    : await prisma.attendanceRecord.create({
        data: { userId, outletId, date, clockIn: now, status: 'present' },
      });

  return res.status(201).json(ApiResponse.created(record, 'Clocked in'));
});

export const clockOut = asyncHandler(async (req: Request, res: Response) => {
  const userId = req.user!.id;
  const date = todayStr();

  const record = await prisma.attendanceRecord.findUnique({
    where: { userId_date: { userId, date } },
  });
  if (!record?.clockIn) throw new ApiError('Not clocked in today', 400);
  if (record.clockOut) throw new ApiError('Already clocked out today', 400);

  let status = 'present';
  const weekStart = currentWeekStart();
  const dayIndex = todayDayIndex();

  const schedule = await prisma.staffSchedule.findFirst({
    where: { userId, weekStart, status: 'published' },
    include: { shifts: true },
  });
  const todayShift = schedule?.shifts.find(s => s.dayIndex === dayIndex);

  if (todayShift?.startTime && record.clockIn) {
    const [schedH, schedM] = todayShift.startTime.split(':').map(Number);
    const graceMinutes = schedH * 60 + schedM + 15;
    // clockIn is UTC; schedule times are PKT (UTC+5). Adjust by 300 min.
    const clockInMinutes =
      record.clockIn.getUTCHours() * 60 + record.clockIn.getUTCMinutes() + 300;
    if (clockInMinutes % (24 * 60) > graceMinutes) status = 'late';
  }

  const updated = await prisma.attendanceRecord.update({
    where: { id: record.id },
    data: { clockOut: new Date(), status },
  });

  return res.json(ApiResponse.success(updated, 'Clocked out'));
});

export const getMyStatus = asyncHandler(async (req: Request, res: Response) => {
  const userId = req.user!.id;
  const date = todayStr();
  const record = await prisma.attendanceRecord.findUnique({
    where: { userId_date: { userId, date } },
  });
  return res.json(ApiResponse.success(record));
});

export const getMyHistory = asyncHandler(async (req: Request, res: Response) => {
  const userId = req.user!.id;
  const { page = '1', limit = '30' } = req.query as Record<string, string>;
  const skip = (Number(page) - 1) * Number(limit);

  const [data, total] = await Promise.all([
    prisma.attendanceRecord.findMany({
      where: { userId },
      skip,
      take: Number(limit),
      orderBy: { date: 'desc' },
    }),
    prisma.attendanceRecord.count({ where: { userId } }),
  ]);

  return res.json(ApiResponse.paginated(data, Number(page), Number(limit), total));
});

export const getAllAttendance = asyncHandler(async (req: Request, res: Response) => {
  const { date, userId, status, page = '1', limit = '50' } = req.query as Record<string, string>;
  const skip = (Number(page) - 1) * Number(limit);

  const where: any = {};
  if (date) where.date = date;
  if (userId) where.userId = userId;
  if (status) where.status = status;

  const scope = resolveOutletScope(req);
  if (scope) where.outletId = scope;

  const [data, total] = await Promise.all([
    prisma.attendanceRecord.findMany({
      where,
      skip,
      take: Number(limit),
      orderBy: [{ date: 'desc' }, { clockIn: 'desc' }],
      include: { user: { select: { id: true, name: true, role: true } } },
    }),
    prisma.attendanceRecord.count({ where }),
  ]);

  return res.json(ApiResponse.paginated(data, Number(page), Number(limit), total));
});

export const correctAttendance = asyncHandler(async (req: Request, res: Response) => {
  const existing = await prisma.attendanceRecord.findUnique({ where: { id: req.params.id } });
  if (!existing) throw new ApiError('Attendance record not found', 404);

  const scope = resolveOutletScope(req);
  if (scope && existing.outletId !== scope) throw new ApiError('Attendance record not found', 404);

  const schema = z.object({
    clockIn:  z.string().datetime().nullable().optional(),
    clockOut: z.string().datetime().nullable().optional(),
    status:   z.enum(['present', 'late', 'absent']).optional(),
    notes:    z.string().max(500).nullable().optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) throw new ApiError(parsed.error.errors[0].message, 400);
  const { clockIn: ci, clockOut: co, status, notes } = parsed.data;

  const updated = await prisma.attendanceRecord.update({
    where: { id: req.params.id },
    data: {
      ...(ci !== undefined ? { clockIn: ci ? new Date(ci) : null } : {}),
      ...(co !== undefined ? { clockOut: co ? new Date(co) : null } : {}),
      ...(status !== undefined ? { status } : {}),
      ...(notes !== undefined ? { notes } : {}),
    },
  });

  return res.json(ApiResponse.success(updated, 'Attendance corrected'));
});
