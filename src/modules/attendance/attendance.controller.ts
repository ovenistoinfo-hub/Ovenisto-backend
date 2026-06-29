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

function currentYear(): number {
  return new Date(Date.now() + 5 * 60 * 60 * 1000).getFullYear();
}

function currentWeekStart(): string {
  const pkt = new Date(Date.now() + 5 * 60 * 60 * 1000);
  const day = pkt.getUTCDay(); // 0=Sun
  const diff = day === 0 ? -6 : 1 - day; // days to Monday
  const monMs = Date.now() + 5 * 60 * 60 * 1000 + diff * 86_400_000;
  return new Date(monMs).toISOString().split('T')[0];
}

function todayDayIndex(): number {
  const pkt = new Date(Date.now() + 5 * 60 * 60 * 1000);
  const day = pkt.getUTCDay(); // 0=Sun,1=Mon,...,6=Sat
  return day === 0 ? 6 : day - 1; // Map to: 0=Mon, 1=Tue, ..., 6=Sun
}

function weekStartOfDate(dateStr: string): string {
  const d = new Date(dateStr + 'T00:00:00Z');
  const day = d.getUTCDay();
  const diff = day === 0 ? -6 : 1 - day;
  d.setUTCDate(d.getUTCDate() + diff);
  return d.toISOString().split('T')[0];
}

function dayIndexOfDate(dateStr: string): number {
  const d = new Date(dateStr + 'T00:00:00Z');
  const day = d.getUTCDay();
  return day === 0 ? 6 : day - 1;
}

// Overtime = minutes the actual clock-out falls past the scheduled shift's end time,
// looked up from the live Settings.shiftConfig (not the schedule's own static
// startTime/endTime snapshot) so it always matches what staff see on their schedule.
async function calcOvertimeMinutes(userId: string, outletId: string, recordDate: string, clockOutAt: Date): Promise<number> {
  const weekStart = weekStartOfDate(recordDate);
  const dayIndex = dayIndexOfDate(recordDate);
  const schedule = await prisma.staffSchedule.findFirst({
    where: { userId, weekStart, status: 'published' },
    include: { shifts: true },
  });
  const shift = schedule?.shifts.find(s => s.dayIndex === dayIndex);
  if (!shift?.shiftType || shift.shiftType === 'off') return 0;

  let settings = await prisma.settings.findFirst({ where: { outletId } });
  if (!settings) settings = await prisma.settings.findFirst();
  const shiftConfig = (settings?.shiftConfig as Record<string, { start?: string; end?: string }>) ?? {};
  const endTime = shiftConfig?.[shift.shiftType]?.end;
  const startTime = shiftConfig?.[shift.shiftType]?.start ?? shift.startTime ?? undefined;
  if (!endTime || !startTime) return 0;

  const [eh, em] = endTime.split(':').map(Number);
  const [sh, sm] = startTime.split(':').map(Number);
  const endMinutes = eh * 60 + em;
  const startMinutes = sh * 60 + sm;

  const baseMs = new Date(recordDate + 'T00:00:00Z').getTime();
  let scheduledEndMs = baseMs + endMinutes * 60_000;
  if (endMinutes <= startMinutes) scheduledEndMs += 24 * 60 * 60_000; // shift crosses midnight

  const clockOutPktMs = clockOutAt.getTime() + 5 * 60 * 60 * 1000;
  const overtimeMs = clockOutPktMs - scheduledEndMs;
  return overtimeMs > 0 ? Math.round(overtimeMs / 60_000) : 0;
}

async function autoMarkAbsents(outletId?: string | null) {
  const date = todayStr();
  const weekStart = currentWeekStart();
  const dayIndex = todayDayIndex();

  // Find all active staff users (excluding Riders and Customer Screens)
  const whereClause: any = {
    status: 'active',
    role: { notIn: ['RIDER', 'CUSTOMER_SCREEN', 'ADMIN', 'SUPER_ADMIN'] },
  };
  if (outletId) {
    whereClause.outletId = outletId;
  }

  const staffUsers = await prisma.user.findMany({
    where: whereClause,
    select: { id: true, outletId: true },
  });

  if (staffUsers.length === 0) return;

  // Find who already has an attendance record for today
  const existing = await prisma.attendanceRecord.findMany({
    where: { userId: { in: staffUsers.map(u => u.id) }, date },
    select: { userId: true },
  });
  const existingIds = new Set(existing.map(r => r.userId));

  // Find who is on approved leave covering today
  const onLeave = await prisma.leaveRequest.findMany({
    where: {
      userId: { in: staffUsers.map(u => u.id) },
      status: 'approved',
      startDate: { lte: date },
      endDate: { gte: date },
    },
    select: { userId: true },
  });
  const onLeaveIds = new Set(onLeave.map(r => r.userId));

  // Filter users who need checking
  const toCheck = staffUsers.filter(u => !existingIds.has(u.id) && !onLeaveIds.has(u.id));
  if (toCheck.length === 0) return;

  // Get schedules for these users for today
  const schedules = await prisma.staffSchedule.findMany({
    where: {
      userId: { in: toCheck.map(u => u.id) },
      weekStart,
      status: 'published',
    },
    include: { shifts: true },
  });

  // Get settings for grace minutes
  let settingsList = await prisma.settings.findMany();

  const toMarkAbsent: any[] = [];

  const pktNow = new Date(Date.now() + 5 * 60 * 60 * 1000);
  const nowMinutes = pktNow.getUTCHours() * 60 + pktNow.getUTCMinutes();

  for (const u of toCheck) {
    const sched = schedules.find(s => s.userId === u.id);
    const todayShift = sched?.shifts.find(s => s.dayIndex === dayIndex);
    if (todayShift?.startTime && todayShift.shiftType !== 'off') {
      const userOutletId = u.outletId;
      const settings = settingsList.find(s => s.outletId === userOutletId) || settingsList[0];
      const graceMinutesValue = settings?.graceMinutes ?? 15;
      const [sh, sm] = todayShift.startTime.split(':').map(Number);
      const shiftStartMinutes = sh * 60 + sm;

      if (nowMinutes > shiftStartMinutes + graceMinutesValue + 60) {
        toMarkAbsent.push({
          userId: u.id,
          outletId: u.outletId!,
          date,
          status: 'absent',
        });
      }
    }
  }

  if (toMarkAbsent.length > 0) {
    await prisma.attendanceRecord.createMany({
      data: toMarkAbsent,
      skipDuplicates: true,
    });
  }
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

  let status = 'present';

  // Shift validation logic
  const weekStart = currentWeekStart();
  const dayIndex = todayDayIndex();
  const schedule = await prisma.staffSchedule.findFirst({
    where: { userId, weekStart, status: 'published' },
    include: { shifts: true },
  });
  const todayShift = schedule?.shifts.find(s => s.dayIndex === dayIndex);

  if (todayShift?.shiftType === 'off') {
    throw new ApiError('Today is your scheduled day off. You cannot clock in.', 400);
  }

  if (todayShift?.startTime && todayShift.shiftType !== 'off') {
    let settings = await prisma.settings.findFirst({
      where: { outletId: outletId || undefined }
    });
    if (!settings) {
      settings = await prisma.settings.findFirst();
    }
    const graceMinutesValue = settings?.graceMinutes ?? 15;

    const pktNow = new Date(Date.now() + 5 * 60 * 60 * 1000);
    const nowMinutes = pktNow.getUTCHours() * 60 + pktNow.getUTCMinutes();
    const [sh, sm] = todayShift.startTime.split(':').map(Number);
    const shiftStartMinutes = sh * 60 + sm;

    if (nowMinutes > shiftStartMinutes + graceMinutesValue + 60) {
      // Auto-mark absent in DB
      if (existing) {
        await prisma.attendanceRecord.update({
          where: { id: existing.id },
          data: { status: 'absent' },
        });
      } else {
        await prisma.attendanceRecord.create({
          data: { userId, outletId, date, status: 'absent' },
        });
      }
      throw new ApiError(`Clock-in window has expired (shift started at ${todayShift.startTime}). You are marked as absent today.`, 400);
    }

    if (nowMinutes > shiftStartMinutes + graceMinutesValue) {
      // Fetch leave balance
      const year = currentYear();
      const balance = await prisma.leaveBalance.upsert({
        where: { userId_year: { userId, year } },
        update: {},
        create: { userId, year, halfday: 10, halfdayUsed: 0 },
      });

      if (balance.halfdayUsed < balance.halfday) {
        status = 'halfday';
        // Consume 1 half day
        await prisma.leaveBalance.update({
          where: { id: balance.id },
          data: { halfdayUsed: { increment: 1 } },
        });
      } else {
        // Half days are exhausted! Mark as absent.
        if (existing) {
          await prisma.attendanceRecord.update({
            where: { id: existing.id },
            data: { status: 'absent' },
          });
        } else {
          await prisma.attendanceRecord.create({
            data: { userId, outletId, date, status: 'absent' },
          });
        }
        throw new ApiError(`Clock-in is after the grace period (shift started at ${todayShift.startTime}) and your Half Day leave balance is exhausted. You are marked as absent today.`, 400);
      }
    }
  }

  const record = existing
    ? await prisma.attendanceRecord.update({
        where: { id: existing.id },
        data: { clockIn: now, status },
      })
    : await prisma.attendanceRecord.create({
        data: { userId, outletId, date, clockIn: now, status },
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

  const now = new Date();
  const overtimeMinutes = await calcOvertimeMinutes(userId, record.outletId, record.date, now);

  const updated = await prisma.attendanceRecord.update({
    where: { id: record.id },
    data: { clockOut: now, overtimeMinutes },
  });

  return res.json(ApiResponse.success(updated, 'Clocked out'));
});

export const getMyStatus = asyncHandler(async (req: Request, res: Response) => {
  const userId = req.user!.id;
  const date = todayStr();
  let record = await prisma.attendanceRecord.findUnique({
    where: { userId_date: { userId, date } },
  });

  if (!record) {
    // Check if shift window has expired to auto-mark absent
    const weekStart = currentWeekStart();
    const dayIndex = todayDayIndex();
    const schedule = await prisma.staffSchedule.findFirst({
      where: { userId, weekStart, status: 'published' },
      include: { shifts: true },
    });
    const todayShift = schedule?.shifts.find(s => s.dayIndex === dayIndex);
    if (todayShift?.startTime && todayShift.shiftType !== 'off') {
      const userRec = await prisma.user.findUnique({ where: { id: userId } });
      const outletId = userRec?.outletId;
      if (outletId) {
        let settings = await prisma.settings.findFirst({
          where: { outletId }
        });
        if (!settings) {
          settings = await prisma.settings.findFirst();
        }
        const graceMinutesValue = settings?.graceMinutes ?? 15;
        const pktNow = new Date(Date.now() + 5 * 60 * 60 * 1000);
        const nowMinutes = pktNow.getUTCHours() * 60 + pktNow.getUTCMinutes();
        const [sh, sm] = todayShift.startTime.split(':').map(Number);
        const shiftStartMinutes = sh * 60 + sm;

        if (nowMinutes > shiftStartMinutes + graceMinutesValue + 60) {
          record = await prisma.attendanceRecord.create({
            data: {
              userId,
              outletId,
              date,
              status: 'absent',
            },
          });
        }
      }
    }
  }

  return res.json(ApiResponse.success(record));
});

export const getMyHistory = asyncHandler(async (req: Request, res: Response) => {
  const userId = req.user!.id;
  const { page = '1', limit = '30', startDate, endDate } = req.query as Record<string, string>;
  const skip = (Number(page) - 1) * Number(limit);

  const where: any = { userId };
  if (startDate || endDate) {
    where.date = {};
    if (startDate) where.date.gte = startDate;
    if (endDate)   where.date.lte = endDate;
  }

  const [data, total] = await Promise.all([
    prisma.attendanceRecord.findMany({
      where,
      skip,
      take: Number(limit),
      orderBy: { date: 'desc' },
    }),
    prisma.attendanceRecord.count({ where }),
  ]);

  return res.json(ApiResponse.paginated(data, Number(page), Number(limit), total));
});

export const getAllAttendance = asyncHandler(async (req: Request, res: Response) => {
  const { date, startDate, endDate, userId, status, page = '1', limit = '50' } = req.query as Record<string, string>;
  const skip = (Number(page) - 1) * Number(limit);

  const scope = resolveOutletScope(req);

  // Auto-mark absents for today
  await autoMarkAbsents(scope);

  const where: any = {};
  if (date) {
    where.date = date;
  } else if (startDate || endDate) {
    where.date = {};
    if (startDate) where.date.gte = startDate;
    if (endDate)   where.date.lte = endDate;
  }
  if (userId) where.userId = userId;
  if (status) where.status = status;

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

export const markAbsent = asyncHandler(async (req: Request, res: Response) => {
  const { date } = req.body as { date: string };
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new ApiError('date (YYYY-MM-DD) is required', 400);
  }

  const scope = resolveOutletScope(req);
  if (!scope) throw new ApiError('Select a specific outlet before marking absent', 400);

  // All active staff in this outlet (exclude Riders and Customer Screens)
  const staffUsers = await prisma.user.findMany({
    where: {
      outletId: scope,
      status: 'active',
      role: { notIn: ['RIDER', 'CUSTOMER_SCREEN', 'ADMIN', 'SUPER_ADMIN'] },
    },
    select: { id: true, outletId: true },
  });

  if (staffUsers.length === 0) {
    return res.json(ApiResponse.success({ count: 0 }, 'No staff found for this outlet'));
  }

  // Users who already have an attendance record for the date
  const existing = await prisma.attendanceRecord.findMany({
    where: { userId: { in: staffUsers.map(u => u.id) }, date },
    select: { userId: true },
  });
  const existingIds = new Set(existing.map(r => r.userId));

  // Users on approved leave covering this date
  const onLeave = await prisma.leaveRequest.findMany({
    where: {
      userId: { in: staffUsers.map(u => u.id) },
      status: 'approved',
      startDate: { lte: date },
      endDate: { gte: date },
    },
    select: { userId: true },
  });
  const onLeaveIds = new Set(onLeave.map(r => r.userId));

  // Mark absent only those with no record and not on leave
  const toMark = staffUsers.filter(u => !existingIds.has(u.id) && !onLeaveIds.has(u.id));

  if (toMark.length === 0) {
    return res.json(ApiResponse.success({ count: 0 }, 'All employees are accounted for'));
  }

  await prisma.attendanceRecord.createMany({
    data: toMark.map(u => ({
      userId: u.id,
      outletId: u.outletId!,
      date,
      status: 'absent',
    })),
    skipDuplicates: true,
  });

  return res.json(ApiResponse.success({ count: toMark.length }, `${toMark.length} employee(s) marked absent`));
});

export const correctAttendance = asyncHandler(async (req: Request, res: Response) => {
  const existing = await prisma.attendanceRecord.findUnique({ where: { id: req.params.id } });
  if (!existing) throw new ApiError('Attendance record not found', 404);

  const scope = resolveOutletScope(req);
  if (scope && existing.outletId !== scope) throw new ApiError('Attendance record not found', 404);

  const schema = z.object({
    clockIn:  z.string().datetime().nullable().optional(),
    clockOut: z.string().datetime().nullable().optional(),
    status:   z.enum(['present', 'late', 'halfday', 'absent']).optional(),
    notes:    z.string().max(500).nullable().optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) throw new ApiError(parsed.error.errors[0].message, 400);
  const { clockIn: ci, clockOut: co, status, notes } = parsed.data;

  const overtimeMinutes = co !== undefined
    ? (co ? await calcOvertimeMinutes(existing.userId, existing.outletId, existing.date, new Date(co)) : 0)
    : undefined;

  const updated = await prisma.attendanceRecord.update({
    where: { id: req.params.id },
    data: {
      ...(ci !== undefined ? { clockIn: ci ? new Date(ci) : null } : {}),
      ...(co !== undefined ? { clockOut: co ? new Date(co) : null } : {}),
      ...(status !== undefined ? { status } : {}),
      ...(notes !== undefined ? { notes } : {}),
      ...(overtimeMinutes !== undefined ? { overtimeMinutes } : {}),
    },
  });

  return res.json(ApiResponse.success(updated, 'Attendance corrected'));
});
