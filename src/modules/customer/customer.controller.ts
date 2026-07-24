/**
 * Customer Controller — Phase 6
 */
import type { Request, Response } from 'express';
import { prisma } from '../../config/database.js';
import { ApiResponse } from '../../utils/ApiResponse.js';
import { ApiError } from '../../utils/ApiError.js';
import { asyncHandler } from '../../utils/asyncHandler.js';

function mapCustomer(c: any) {
  return {
    ...c,
    totalSpent: Number(c.totalSpent),
    outstandingDue: Number(c.outstandingDue),
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

  const data = await prisma.customer.findMany({
    where,
    orderBy: { name: 'asc' },
  });

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

  return res.json(ApiResponse.paginated(pagedList.map(mapCustomer), Number(page), Number(limit), total));
});

export const getCustomer = asyncHandler(async (req: Request, res: Response) => {
  const c = await prisma.customer.findUnique({ where: { id: req.params.id } });
  if (!c) throw new ApiError('Customer not found', 404);
  return res.json(ApiResponse.success(mapCustomer(c)));
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
    return res.status(200).json(ApiResponse.success(mapCustomer(updated), 'Customer updated'));
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
  return res.status(201).json(ApiResponse.created(mapCustomer(c), 'Customer created'));
});

export const updateCustomer = asyncHandler(async (req: Request, res: Response) => {
  const { name, phone, email, address, customerType } = req.body;
  const c = await prisma.customer.update({
    where: { id: req.params.id },
    data: { name, phone, email, address, customerType },
  });
  return res.json(ApiResponse.success(mapCustomer(c), 'Customer updated'));
});

export const deleteCustomer = asyncHandler(async (req: Request, res: Response) => {
  await prisma.customer.delete({ where: { id: req.params.id } });
  return res.json(ApiResponse.success(null, 'Customer deleted'));
});
