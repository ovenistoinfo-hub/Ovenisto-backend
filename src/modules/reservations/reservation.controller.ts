import type { Request, Response } from 'express';
import { prisma } from '../../config/database.js';
import { ApiResponse } from '../../utils/ApiResponse.js';
import { ApiError } from '../../utils/ApiError.js';
import { asyncHandler } from '../../utils/asyncHandler.js';
import { resolveOutletScope, resolveCreateOutlet } from '../../middleware/outletScope.js';
import { emitOrderEvent, emitReservationEvent } from '../../socket.js';

function mapReservation(r: any) {
  return {
    ...r,
    date: r.date instanceof Date ? r.date.toISOString().split('T')[0] : r.date,
    advancePaid: r.advancePaid ? Number(r.advancePaid) : 0,
    subtotal: r.subtotal ? Number(r.subtotal) : 0,
    tax: r.tax ? Number(r.tax) : 0,
    totalAmount: r.totalAmount ? Number(r.totalAmount) : 0,
  };
}

/** GET /api/reservations */
export const getReservations = asyncHandler(async (req: Request, res: Response) => {
  const { date, status, upcoming, bookingType } = req.query;
  const scope = resolveOutletScope(req);

  const where: any = {};
  if (scope) where.outletId = scope;
  if (status) where.status = String(status);
  if (bookingType) where.bookingType = String(bookingType);

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
  const {
    customerName, customerPhone, date, time, guestCount, tableId, tableNumber,
    status, specialRequests, source, bookingType, orderType, deliveryAddress,
    advancePaid, paymentMethod, paymentStatus, depositRef, preOrderItems,
    subtotal, tax, totalAmount,
  } = req.body;

  if (!customerName?.trim()) throw ApiError.badRequest('Customer name is required');
  if (!date) throw ApiError.badRequest('Date is required');
  if (!time) throw ApiError.badRequest('Time is required');

  const now = new Date();
  const dateStr = new Date(String(date)).toISOString().split('T')[0];
  const todayStr = now.toISOString().split('T')[0];
  const currentHHMM = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;

  if (dateStr < todayStr) {
    throw ApiError.badRequest('Cannot book a reservation for a past date');
  }
  if (dateStr === todayStr && String(time) < currentHHMM) {
    throw ApiError.badRequest(`Cannot book a reservation for a past time (current time is ${currentHHMM})`);
  }

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
      bookingType: bookingType || 'table_reservation',
      orderType: orderType || 'Dine In',
      deliveryAddress: deliveryAddress || null,
      advancePaid: advancePaid ? Number(advancePaid) : 0,
      paymentMethod: paymentMethod || null,
      paymentStatus: paymentStatus || (advancePaid > 0 ? 'deposit_paid' : 'unpaid'),
      depositRef: depositRef || null,
      preOrderItems: preOrderItems || null,
      subtotal: subtotal ? Number(subtotal) : 0,
      tax: tax ? Number(tax) : 0,
      totalAmount: totalAmount ? Number(totalAmount) : 0,
    },
  });

  const mapped = mapReservation(reservation);
  emitReservationEvent('reservation:created', mapped, [reservation.outletId]);

  res.status(201).json(ApiResponse.created(mapped, 'Reservation created'));
});

/** PUT /api/reservations/:id */
export const updateReservation = asyncHandler(async (req: Request, res: Response) => {
  const { id } = req.params;
  const {
    customerName, customerPhone, date, time, guestCount, tableId, tableNumber,
    status, specialRequests, source, bookingType, orderType, deliveryAddress,
    advancePaid, paymentMethod, paymentStatus, depositRef, preOrderItems,
    subtotal, tax, totalAmount, isAdvanceAdjusted, orderId,
  } = req.body;

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
      ...(bookingType !== undefined && { bookingType: String(bookingType) }),
      ...(orderType !== undefined && { orderType: String(orderType) }),
      ...(deliveryAddress !== undefined && { deliveryAddress: deliveryAddress || null }),
      ...(advancePaid !== undefined && { advancePaid: Number(advancePaid) }),
      ...(paymentMethod !== undefined && { paymentMethod: paymentMethod || null }),
      ...(paymentStatus !== undefined && { paymentStatus: String(paymentStatus) }),
      ...(depositRef !== undefined && { depositRef: depositRef || null }),
      ...(preOrderItems !== undefined && { preOrderItems }),
      ...(subtotal !== undefined && { subtotal: Number(subtotal) }),
      ...(tax !== undefined && { tax: Number(tax) }),
      ...(totalAmount !== undefined && { totalAmount: Number(totalAmount) }),
      ...(isAdvanceAdjusted !== undefined && { isAdvanceAdjusted: Boolean(isAdvanceAdjusted) }),
      ...(orderId !== undefined && { orderId: orderId || null }),
    },
  });

  const mapped = mapReservation(reservation);
  emitReservationEvent('reservation:updated', mapped, [reservation.outletId]);

  res.json(ApiResponse.success(mapped, 'Reservation updated'));
});

/** DELETE /api/reservations/:id */
export const deleteReservation = asyncHandler(async (req: Request, res: Response) => {
  const existing = await prisma.reservation.findUnique({ where: { id: req.params.id } });
  if (!existing) throw ApiError.notFound('Reservation not found');
  const scope = resolveOutletScope(req);
  if (scope && existing.outletId !== scope) throw ApiError.notFound('Reservation not found');

  await prisma.reservation.delete({ where: { id: req.params.id } });
  emitReservationEvent('reservation:deleted', { id: req.params.id }, [existing.outletId]);

  res.json(ApiResponse.success(null, 'Reservation deleted'));
});

/** POST /api/reservations/:id/convert-to-order */
export const convertReservationToOrder = asyncHandler(async (req: Request, res: Response) => {
  const { id } = req.params;
  const existing = await prisma.reservation.findUnique({ where: { id } });
  if (!existing) throw ApiError.notFound('Reservation not found');
  const scope = resolveOutletScope(req);
  if (scope && existing.outletId !== scope) throw ApiError.notFound('Reservation not found');

  if (existing.orderId) {
    const existingOrder = await prisma.order.findUnique({
      where: { id: existing.orderId },
      include: { items: true },
    });
    if (existingOrder) {
      res.json(ApiResponse.success(existingOrder, 'Reservation was already converted to order'));
      return;
    }
  }

  const count = await prisma.order.count();
  const orderNumber = `ORD-${String(count + 1).padStart(5, '0')}`;

  const typeMap: Record<string, any> = {
    'Dine In': 'DINE_IN',
    'Take Away': 'TAKE_AWAY',
    'Delivery': 'DELIVERY',
  };
  const prismaType = typeMap[existing.orderType || 'Dine In'] || 'DINE_IN';

  const rawItems = Array.isArray(existing.preOrderItems) ? (existing.preOrderItems as any[]) : [];
  const itemsToCreate = rawItems.map((item: any) => ({
    menuItemId: item.menuItemId || null,
    variantId: item.variantId || null,
    name: item.name || 'Custom Item',
    price: item.price ?? 0,
    qty: item.qty ?? 1,
    discount: item.discount ?? 0,
    modifiers: item.modifiers || [],
    notes: item.notes || null,
  }));

  const order = await prisma.order.create({
    data: {
      orderNumber,
      outletId: existing.outletId,
      customerName: existing.customerName,
      phone: existing.customerPhone,
      type: prismaType,
      subtotal: existing.subtotal ? Number(existing.subtotal) : 0,
      tax: existing.tax ? Number(existing.tax) : 0,
      total: existing.totalAmount ? Number(existing.totalAmount) : (existing.subtotal ? Number(existing.subtotal) : 0),
      status: 'PENDING',
      paymentMethod: (existing.advancePaid && Number(existing.advancePaid) >= (existing.totalAmount ? Number(existing.totalAmount) : (existing.subtotal ? Number(existing.subtotal) : 0))) ? (existing.paymentMethod || 'Cash') : 'Pending',
      date: new Date(),
      time: existing.time,
      tableNumber: existing.tableNumber ? parseInt(existing.tableNumber, 10) : null,
      deliveryAddress: existing.deliveryAddress || null,
      isFutureSale: existing.bookingType === 'future_order',
      scheduledDate: existing.date,
      scheduledTime: existing.time,
      futureNotes: existing.specialRequests || null,
      advancePayment: existing.advancePaid ? Number(existing.advancePaid) : 0,
      orderSource: 'reservation',
      items: itemsToCreate.length > 0 ? { create: itemsToCreate } : undefined,
    },
    include: { items: true },
  });

  const updatedRes = await prisma.reservation.update({
    where: { id },
    data: {
      orderId: order.id,
      status: existing.bookingType === 'table_reservation' ? 'seated' : 'confirmed',
    },
  });

  emitReservationEvent('reservation:updated', mapReservation(updatedRes), [existing.outletId]);

  if (existing.tableId) {
    await prisma.restaurantTable.update({
      where: { id: existing.tableId },
      data: {
        status: 'occupied',
        currentOrderId: order.id,
        reservationId: existing.id,
      },
    });
  }

  emitOrderEvent('order:created', order);

  res.json(ApiResponse.success(order, 'Reservation converted to active order successfully'));
});

