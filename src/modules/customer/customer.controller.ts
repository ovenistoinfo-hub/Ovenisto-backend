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

  const [data, total] = await Promise.all([
    prisma.customer.findMany({ where, skip, take: Number(limit), orderBy: { name: 'asc' } }),
    prisma.customer.count({ where }),
  ]);

  return res.json(ApiResponse.paginated(data.map(mapCustomer), Number(page), Number(limit), total));
});

export const getCustomer = asyncHandler(async (req: Request, res: Response) => {
  const c = await prisma.customer.findUnique({ where: { id: req.params.id } });
  if (!c) throw new ApiError('Customer not found', 404);
  return res.json(ApiResponse.success(mapCustomer(c)));
});

export const createCustomer = asyncHandler(async (req: Request, res: Response) => {
  const { name, phone, email, address, customerType } = req.body;
  if (!name) throw new ApiError('Name is required', 400);
  const c = await prisma.customer.create({
    data: { name, phone: phone || null, email: email || null, address: address || null, customerType: customerType || 'walk-in' },
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
