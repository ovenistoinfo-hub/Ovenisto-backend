/**
 * Supplier Controller — Phase 7
 */
import type { Request, Response } from 'express';
import { prisma } from '../../config/database.js';
import { ApiResponse } from '../../utils/ApiResponse.js';
import { ApiError } from '../../utils/ApiError.js';
import { asyncHandler } from '../../utils/asyncHandler.js';

function mapSupplier(s: any) {
  return {
    ...s,
    totalPurchases: Number(s.totalPurchases),
    totalDue: Number(s.totalDue),
  };
}

export const getSuppliers = asyncHandler(async (req: Request, res: Response) => {
  const { search } = req.query as Record<string, string>;

  const where: any = {};
  if (search) {
    where.OR = [
      { name: { contains: search, mode: 'insensitive' } },
      { company: { contains: search, mode: 'insensitive' } },
    ];
  }

  const data = await prisma.supplier.findMany({ where, orderBy: { name: 'asc' } });
  return res.json(ApiResponse.success(data.map(mapSupplier)));
});

export const getSupplier = asyncHandler(async (req: Request, res: Response) => {
  const s = await prisma.supplier.findUnique({ where: { id: req.params.id } });
  if (!s) throw new ApiError('Supplier not found', 404);
  return res.json(ApiResponse.success(mapSupplier(s)));
});

export const createSupplier = asyncHandler(async (req: Request, res: Response) => {
  const { name, company, phone, email } = req.body;
  if (!name) throw new ApiError('Name is required', 400);
  const s = await prisma.supplier.create({
    data: {
      name,
      company: company || null,
      phone: phone || null,
      email: email || null,
    },
  });
  return res.status(201).json(ApiResponse.created(mapSupplier(s), 'Supplier created'));
});

export const updateSupplier = asyncHandler(async (req: Request, res: Response) => {
  const { name, company, phone, email } = req.body;
  const existing = await prisma.supplier.findUnique({ where: { id: req.params.id } });
  if (!existing) throw new ApiError('Supplier not found', 404);
  const s = await prisma.supplier.update({
    where: { id: req.params.id },
    data: { name, company, phone, email },
  });
  return res.json(ApiResponse.success(mapSupplier(s), 'Supplier updated'));
});

export const deleteSupplier = asyncHandler(async (req: Request, res: Response) => {
  const s = await prisma.supplier.findUnique({ where: { id: req.params.id } });
  if (!s) throw new ApiError('Supplier not found', 404);
  if (Number(s.totalDue) > 0) {
    throw new ApiError('Cannot delete supplier with outstanding dues', 400);
  }
  await prisma.supplier.delete({ where: { id: req.params.id } });
  return res.json(ApiResponse.success(null, 'Supplier deleted'));
});

export const recordPayment = asyncHandler(async (req: Request, res: Response) => {
  const { amount, paymentMethod } = req.body;
  if (!amount || Number(amount) <= 0) {
    throw new ApiError('Valid payment amount is required', 400);
  }

  const s = await prisma.supplier.findUnique({ where: { id: req.params.id } });
  if (!s) throw new ApiError('Supplier not found', 404);

  const newDue = Math.max(0, Number(s.totalDue) - Number(amount));
  const updated = await prisma.supplier.update({
    where: { id: req.params.id },
    data: { totalDue: newDue },
  });

  return res.json(ApiResponse.success(mapSupplier(updated), 'Payment recorded'));
});
