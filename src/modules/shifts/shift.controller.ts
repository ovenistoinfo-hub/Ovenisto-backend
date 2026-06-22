/**
 * Shift / Cash Register Controller
 */
import type { Request, Response } from 'express';
import { prisma } from '../../config/database.js';
import { ApiResponse } from '../../utils/ApiResponse.js';
import { ApiError } from '../../utils/ApiError.js';
import { asyncHandler } from '../../utils/asyncHandler.js';
import { resolveOutletScope, resolveCreateOutlet } from '../../middleware/outletScope.js';

function mapShift(s: any) {
  if (!s) return s;
  return {
    ...s,
    openingCash:      Number(s.openingCash ?? 0),
    closingCash:      s.closingCash != null ? Number(s.closingCash) : null,
    totalSales:       Number(s.totalSales ?? 0),
    totalCashSales:   Number(s.totalCashSales ?? 0),
    totalCardSales:   Number(s.totalCardSales ?? 0),
    totalOnlineSales: Number(s.totalOnlineSales ?? 0),
    totalExpenses:    Number(s.totalExpenses ?? 0),
    expectedCash:     Number(s.expectedCash ?? 0),
    cashDifference:   s.cashDifference != null ? Number(s.cashDifference) : null,
  };
}

async function generateShiftNumber(): Promise<string> {
  const count = await prisma.shift.count();
  let n = count + 1;
  while (n <= 9999) {
    const candidate = `SH-${String(n).padStart(3, '0')}`;
    const exists = await prisma.shift.findUnique({ where: { shiftNumber: candidate } });
    if (!exists) return candidate;
    n++;
  }
  return `SH-${Date.now().toString().slice(-6)}`;
}

/** GET /api/shifts/active — public */
export const getActiveShift = asyncHandler(async (req: Request, res: Response) => {
  const scope = resolveOutletScope(req);
  const shift = await prisma.shift.findFirst({ where: { status: 'open', ...(scope ? { outletId: scope } : {}) }, orderBy: { openedAt: 'desc' } });
  res.json(ApiResponse.success(shift ? mapShift(shift) : null));
});

/** GET /api/shifts */
export const getShifts = asyncHandler(async (req: Request, res: Response) => {
  const { status, page = '1', limit = '20' } = req.query as Record<string, string>;
  const skip = (Number(page) - 1) * Number(limit);
  const where: any = {};
  if (status) where.status = status;
  const scope = resolveOutletScope(req);
  if (scope) where.outletId = scope;

  const [shifts, total] = await Promise.all([
    prisma.shift.findMany({ where, skip, take: Number(limit), orderBy: { openedAt: 'desc' } }),
    prisma.shift.count({ where }),
  ]);
  res.json(ApiResponse.paginated(shifts.map(mapShift), Number(page), Number(limit), total));
});

/** POST /api/shifts — open new shift */
export const createShift = asyncHandler(async (req: Request, res: Response) => {
  const { openingCash, notes } = req.body;
  if (openingCash === undefined || openingCash === null) throw ApiError.badRequest('Opening cash is required');

  const outletId = resolveCreateOutlet(req);
  const existing = await prisma.shift.findFirst({ where: { status: 'open', outletId } });
  if (existing) throw ApiError.badRequest('A shift is already open. Close it before opening a new one.');

  const shiftNumber = await generateShiftNumber();
  const shift = await prisma.shift.create({
    data: {
      shiftNumber,
      cashierId:   req.user?.id || null,
      cashierName: req.user?.name || null,
      outletId,
      openedAt:    new Date(),
      openingCash,
      expectedCash: openingCash,
      status: 'open',
      notes: notes || null,
    },
  });
  res.status(201).json(ApiResponse.created(mapShift(shift), 'Register opened'));
});

/** PUT /api/shifts/:id/close */
export const closeShift = asyncHandler(async (req: Request, res: Response) => {
  const { id } = req.params;
  const {
    closingCash, totalSales = 0, totalCashSales = 0, totalCardSales = 0,
    totalOnlineSales = 0, orderCount = 0, cancelledOrders = 0,
    totalExpenses = 0, notes,
  } = req.body;

  const shift = await prisma.shift.findUnique({ where: { id } });
  if (!shift) throw ApiError.notFound('Shift not found');
  const scope = resolveOutletScope(req);
  if (scope && shift.outletId !== scope) throw ApiError.notFound('Shift not found');
  if (shift.status === 'closed') throw ApiError.badRequest('Shift is already closed');

  const expectedCash = Number(shift.openingCash ?? 0) + Number(totalCashSales);
  const cashDifference = closingCash != null ? Number(closingCash) - expectedCash : null;

  const updated = await prisma.shift.update({
    where: { id },
    data: {
      status: 'closed',
      closedAt:        new Date(),
      closingCash:     closingCash ?? null,
      totalSales,
      totalCashSales,
      totalCardSales,
      totalOnlineSales,
      orderCount,
      cancelledOrders,
      totalExpenses,
      expectedCash,
      cashDifference,
      notes: notes || null,
    },
  });
  res.json(ApiResponse.success(mapShift(updated), 'Register closed'));
});
