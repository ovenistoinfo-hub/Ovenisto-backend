/**
 * Customer Controller — Phase 6
 */
import type { Request, Response } from 'express';
import { prisma } from '../../config/database.js';
import { ApiResponse } from '../../utils/ApiResponse.js';
import { ApiError } from '../../utils/ApiError.js';
import { asyncHandler } from '../../utils/asyncHandler.js';

async function getCustomerStatsMap() {
  const orders = await prisma.order.findMany({
    select: {
      customerId: true,
      customerName: true,
      phone: true,
      total: true,
      status: true,
      paymentMethod: true,
    },
  });

  const map: Record<string, { totalOrders: number; totalSpent: number; outstandingDue: number }> = {};
  for (const o of orders) {
    if (!o.customerName || o.customerName.toLowerCase() === 'walk-in') continue;

    const nameKey = `name:${o.customerName.toLowerCase().trim()}`;
    const cleanPhone = o.phone ? o.phone.replace(/\D/g, '') : '';
    const isDummy = !cleanPhone || cleanPhone === '00000000000' || cleanPhone === '11111111111' || cleanPhone === '12345678901';
    const phoneKey = (!isDummy && cleanPhone.length >= 7) ? `phone:${cleanPhone}` : null;
    const idKey = o.customerId ? `id:${o.customerId}` : null;

    const key = idKey || phoneKey || nameKey;

    if (!map[key]) {
      map[key] = { totalOrders: 0, totalSpent: 0, outstandingDue: 0 };
    }

    if (phoneKey && !map[phoneKey]) map[phoneKey] = map[key];
    if (nameKey && !map[nameKey]) map[nameKey] = map[key];
    if (idKey && !map[idKey]) map[idKey] = map[key];

    const amt = Number(o.total || 0);
    const isCancelled = String(o.status).toLowerCase() === 'cancelled';
    const isUnpaid = !o.paymentMethod || o.paymentMethod === 'Pending' || o.paymentMethod === 'Unpaid';

    map[key].totalOrders += 1;
    if (!isCancelled) {
      map[key].totalSpent += amt;
    }
    if (!isCancelled && isUnpaid) {
      map[key].outstandingDue += amt;
    }
  }

  return map;
}

function mapCustomerWithStats(c: any, statsMap?: Record<string, any>) {
  const cleanPhone = c.phone ? c.phone.replace(/\D/g, '') : '';
  const isDummy = !cleanPhone || cleanPhone === '00000000000' || cleanPhone === '11111111111' || cleanPhone === '12345678901';

  const stat = statsMap
    ? (statsMap[`id:${c.id}`] ||
       (!isDummy && cleanPhone.length >= 7 ? statsMap[`phone:${cleanPhone}`] : null) ||
       statsMap[`name:${c.name.toLowerCase().trim()}`])
    : null;

  return {
    ...c,
    totalOrders: stat ? stat.totalOrders : (c.totalOrders || 0),
    totalSpent: stat ? Math.round(stat.totalSpent) : Number(c.totalSpent || 0),
    outstandingDue: stat ? Math.round(stat.outstandingDue) : Number(c.outstandingDue || 0),
  };
}

export const getCustomers = asyncHandler(async (req: Request, res: Response) => {
  const { search, customerType, page = '1', limit = '100' } = req.query as Record<string, string>;
  const skip = (Number(page) - 1) * Number(limit);

  const where: any = {};
  if (search) {
    where.OR = [
      { name: { contains: search, mode: 'insensitive' } },
      { phone: { contains: search, mode: 'insensitive' } },
      { email: { contains: search, mode: 'insensitive' } },
    ];
  }
  if (customerType) where.customerType = customerType;

  const [data, statsMap] = await Promise.all([
    prisma.customer.findMany({
      where,
      orderBy: { name: 'asc' },
    }),
    getCustomerStatsMap(),
  ]);

  const deduplicatedMap = new Map<string, any>();
  for (const c of data) {
    const cleanPhone = c.phone ? c.phone.replace(/\D/g, '') : '';
    const isDummy = !cleanPhone || cleanPhone === '00000000000' || cleanPhone === '11111111111' || cleanPhone === '12345678901';
    const key = (!isDummy && cleanPhone.length >= 7)
      ? `phone:${cleanPhone}`
      : `name:${c.name.toLowerCase().trim()}`;

    if (!deduplicatedMap.has(key)) {
      deduplicatedMap.set(key, c);
    } else {
      const existing = deduplicatedMap.get(key)!;
      if (!existing.phone && c.phone) existing.phone = c.phone;
      if (!existing.email && c.email) existing.email = c.email;
      if (!existing.address && c.address) existing.address = c.address;
    }
  }

  const uniqueList = Array.from(deduplicatedMap.values());
  const total = uniqueList.length;
  const pagedList = uniqueList.slice(skip, skip + Number(limit));

  return res.json(ApiResponse.paginated(pagedList.map((c) => mapCustomerWithStats(c, statsMap)), Number(page), Number(limit), total));
});

export const getCustomer = asyncHandler(async (req: Request, res: Response) => {
  const [c, statsMap] = await Promise.all([
    prisma.customer.findUnique({ where: { id: req.params.id } }),
    getCustomerStatsMap(),
  ]);
  if (!c) throw new ApiError('Customer not found', 404);
  return res.json(ApiResponse.success(mapCustomerWithStats(c, statsMap)));
});

export const createCustomer = asyncHandler(async (req: Request, res: Response) => {
  const { name, phone, email, address, customerType } = req.body;
  if (!name) throw new ApiError('Name is required', 400);

  const cleanPhone = phone ? String(phone).replace(/\D/g, '') : '';
  const isDummyPhone = !cleanPhone || cleanPhone === '00000000000' || cleanPhone === '11111111111' || cleanPhone === '12345678901';

  let existing = null;
  if (!isDummyPhone && cleanPhone.length >= 7) {
    existing = await prisma.customer.findFirst({
      where: {
        phone: { contains: cleanPhone },
      },
    });
  }

  if (!existing && name.trim()) {
    existing = await prisma.customer.findFirst({
      where: {
        name: { equals: name.trim(), mode: 'insensitive' },
      },
    });
  }

  if (existing) {
    const updated = await prisma.customer.update({
      where: { id: existing.id },
      data: {
        name: name.trim() || existing.name,
        phone: phone ? phone.trim() : existing.phone,
        email: email ? email.trim() : existing.email,
        address: address ? address.trim() : existing.address,
        customerType: customerType || existing.customerType,
      },
    });
    return res.status(200).json(ApiResponse.success(mapCustomerWithStats(updated), 'Customer updated'));
  }

  const c = await prisma.customer.create({
    data: {
      name: name.trim(),
      phone: phone ? phone.trim() : null,
      email: email ? email.trim() : null,
      address: address ? address.trim() : null,
      customerType: customerType || 'walk-in',
    },
  });
  return res.status(201).json(ApiResponse.created(mapCustomerWithStats(c), 'Customer created'));
});

export const updateCustomer = asyncHandler(async (req: Request, res: Response) => {
  const { name, phone, email, address, customerType } = req.body;
  const c = await prisma.customer.update({
    where: { id: req.params.id },
    data: { name, phone, email, address, customerType },
  });
  return res.json(ApiResponse.success(mapCustomerWithStats(c), 'Customer updated'));
});

export const deleteCustomer = asyncHandler(async (req: Request, res: Response) => {
  await prisma.customer.delete({ where: { id: req.params.id } });
  return res.json(ApiResponse.success(null, 'Customer deleted'));
});
