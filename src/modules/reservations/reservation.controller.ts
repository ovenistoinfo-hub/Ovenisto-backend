import type { Request, Response } from 'express';
import { prisma } from '../../config/database.js';
import { ApiResponse } from '../../utils/ApiResponse.js';
import { ApiError } from '../../utils/ApiError.js';
import { asyncHandler } from '../../utils/asyncHandler.js';
import { resolveOutletScope, resolveCreateOutlet } from '../../middleware/outletScope.js';

function mapReservation(r: any) {
  return {
    ...r,
    date: r.date instanceof Date ? r.date.toISOString().split('T')[0] : r.date,
  };
}

/** GET /api/reservations */
export const getReservations = asyncHandler(async (req: Request, res: Response) => {
  const { date, status, upcoming } = req.query;
  const scope = resolveOutletScope(req);

  const where: any = {};
  if (scope) where.outletId = scope;
  if (status) where.status = String(status);

  if (upcoming === 'true') {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    where.date = { gte: today };
    where.status = { notIn: ['cancelled', 'noShow'] };
  } else if (date) {
    const d = new Date(String(date));
    const next = new Date(d);
    next.setDate(next.getDate() + 1);
    where.date = { gte: d, lt: next };
  }

  const reservations = await prisma.reservation.findMany({
    where,
    orderBy: [{ date: 'asc' }, { time: 'asc' }],
  });

  res.json(ApiResponse.success(reservations.map(mapReservation)));
});

/** POST /api/reservations */
export const createReservation = asyncHandler(async (req: Request, res: Response) => {
  const { customerName, customerPhone, date, time, guestCount, tableId, tableNumber, status, specialRequests, source } = req.body;
  if (!customerName?.trim()) throw ApiError.badRequest('Customer name is required');
  if (!date) throw ApiError.badRequest('Date is required');
  if (!time) throw ApiError.badRequest('Time is required');

  const outletId = resolveCreateOutlet(req);

  const reservation = await prisma.reservation.create({
    data: {
      customerName: String(customerName).trim(),
      customerPhone: customerPhone || null,
      date: new Date(String(date)),
      time: String(time),
      guestCount: guestCount ? Number(guestCount) : 1,
      tableId: tableId || null,
      tableNumber: tableNumber || null,
      status: status || 'pending',
      specialRequests: specialRequests || null,
      source: source || 'phone',
      outletId,
    },
  });

  res.status(201).json(ApiResponse.created(mapReservation(reservation), 'Reservation created'));
});

/** PUT /api/reservations/:id */
export const updateReservation = asyncHandler(async (req: Request, res: Response) => {
  const { id } = req.params;
  const { customerName, customerPhone, date, time, guestCount, tableId, tableNumber, status, specialRequests, source } = req.body;

  const existing = await prisma.reservation.findUnique({ where: { id } });
  if (!existing) throw ApiError.notFound('Reservation not found');
  const scope = resolveOutletScope(req);
  if (scope && existing.outletId !== scope) throw ApiError.notFound('Reservation not found');

  const reservation = await prisma.reservation.update({
    where: { id },
    data: {
      ...(customerName !== undefined && { customerName: String(customerName).trim() }),
      ...(customerPhone !== undefined && { customerPhone: customerPhone || null }),
      ...(date !== undefined && { date: new Date(String(date)) }),
      ...(time !== undefined && { time: String(time) }),
      ...(guestCount !== undefined && { guestCount: Number(guestCount) }),
      ...(tableId !== undefined && { tableId: tableId || null }),
      ...(tableNumber !== undefined && { tableNumber: tableNumber || null }),
      ...(status !== undefined && { status: String(status) }),
      ...(specialRequests !== undefined && { specialRequests: specialRequests || null }),
      ...(source !== undefined && { source: String(source) }),
    },
  });

  res.json(ApiResponse.success(mapReservation(reservation), 'Reservation updated'));
});

/** DELETE /api/reservations/:id */
export const deleteReservation = asyncHandler(async (req: Request, res: Response) => {
  const existing = await prisma.reservation.findUnique({ where: { id: req.params.id } });
  if (!existing) throw ApiError.notFound('Reservation not found');
  const scope = resolveOutletScope(req);
  if (scope && existing.outletId !== scope) throw ApiError.notFound('Reservation not found');

  await prisma.reservation.delete({ where: { id: req.params.id } });
  res.json(ApiResponse.success(null, 'Reservation deleted'));
});
