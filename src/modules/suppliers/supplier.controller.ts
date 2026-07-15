/**
 * Supplier Controller — Phase 7
 */
import type { Request, Response } from 'express';
import { prisma } from '../../config/database.js';
import { ApiResponse } from '../../utils/ApiResponse.js';
import { ApiError } from '../../utils/ApiError.js';
import { asyncHandler } from '../../utils/asyncHandler.js';
import { resolveOutletScope } from '../../middleware/outletScope.js';

function mapSupplier(s: any) {
  return {
    ...s,
    totalPurchases: Number(s.totalPurchases),
    totalDue: Number(s.totalDue),
  };
}

export function checkSupplierAccess(req: Request, supplierOutletId: string | null) {
  if (req.user?.role === 'Super Admin') {
    if (supplierOutletId !== null) {
      throw new ApiError('Supplier not found', 404);
    }
  } else {
    const scope = resolveOutletScope(req);
    if (!scope || supplierOutletId !== scope) {
      throw new ApiError('Supplier not found', 404);
    }
  }
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

  const scope = resolveOutletScope(req);
  if (req.user?.role === 'Super Admin') {
    where.outletId = null;
  } else if (scope) {
    where.outletId = scope;
  } else {
    where.outletId = 'none';
  }

  const data = await prisma.supplier.findMany({ where, orderBy: { name: 'asc' } });
  return res.json(ApiResponse.success(data.map(mapSupplier)));
});

export const getSupplier = asyncHandler(async (req: Request, res: Response) => {
  const s = await prisma.supplier.findUnique({ where: { id: req.params.id } });
  if (!s) throw new ApiError('Supplier not found', 404);
  checkSupplierAccess(req, s.outletId);
  return res.json(ApiResponse.success(mapSupplier(s)));
});

export const createSupplier = asyncHandler(async (req: Request, res: Response) => {
  const { name, company, phone, email } = req.body;
  if (!name) throw new ApiError('Name is required', 400);

  const outletId = req.user?.role === 'Super Admin' ? null : (req.user?.outletId ?? null);

  const s = await prisma.supplier.create({
    data: {
      name,
      company: company || null,
      phone: phone || null,
      email: email || null,
      outletId,
    },
  });
  return res.status(201).json(ApiResponse.created(mapSupplier(s), 'Supplier created'));
});

export const updateSupplier = asyncHandler(async (req: Request, res: Response) => {
  const { name, company, phone, email } = req.body;
  const existing = await prisma.supplier.findUnique({ where: { id: req.params.id } });
  if (!existing) throw new ApiError('Supplier not found', 404);
  checkSupplierAccess(req, existing.outletId);

  const s = await prisma.supplier.update({
    where: { id: req.params.id },
    data: { name, company, phone, email },
  });
  return res.json(ApiResponse.success(mapSupplier(s), 'Supplier updated'));
});

export const deleteSupplier = asyncHandler(async (req: Request, res: Response) => {
  const s = await prisma.supplier.findUnique({ where: { id: req.params.id } });
  if (!s) throw new ApiError('Supplier not found', 404);
  checkSupplierAccess(req, s.outletId);

  if (Number(s.totalDue) > 0) {
    throw new ApiError('Cannot delete supplier with outstanding dues', 400);
  }
  await prisma.supplier.delete({ where: { id: req.params.id } });
  return res.json(ApiResponse.success(null, 'Supplier deleted'));
});

export const recordPayment = asyncHandler(async (req: Request, res: Response) => {
  const { amount } = req.body;
  if (!amount || Number(amount) <= 0) {
    throw new ApiError('Valid payment amount is required', 400);
  }

  const s = await prisma.supplier.findUnique({ where: { id: req.params.id } });
  if (!s) throw new ApiError('Supplier not found', 404);
  checkSupplierAccess(req, s.outletId);

  const newDue = Math.max(0, Number(s.totalDue) - Number(amount));
  const updated = await prisma.supplier.update({
    where: { id: req.params.id },
    data: { totalDue: newDue },
  });

  return res.json(ApiResponse.success(mapSupplier(updated), 'Payment recorded'));
});

export const getSupplierIngredients = asyncHandler(async (req: Request, res: Response) => {
  const { id } = req.params;
  const supplier = await prisma.supplier.findUnique({ where: { id } });
  if (!supplier) throw new ApiError('Supplier not found', 404);
  checkSupplierAccess(req, supplier.outletId);

  const ingredients = await prisma.ingredient.findMany({
    where: { supplierId: id, status: 'active' },
    orderBy: { name: 'asc' },
    include: {
      category: { select: { id: true, name: true } },
      unit: { select: { id: true, name: true } },
      supplier: { select: { id: true, name: true } },
    },
  });
  return res.json(ApiResponse.success(ingredients));
});

export const getSupplierLedger = asyncHandler(async (req: Request, res: Response) => {
  const { id } = req.params;
  const supplier = await prisma.supplier.findUnique({ where: { id } });
  if (!supplier) throw new ApiError('Supplier not found', 404);
  checkSupplierAccess(req, supplier.outletId);

  // Fetch purchases with payment history
  const purchases = await prisma.purchase.findMany({
    where: { supplierId: id },
    orderBy: { createdAt: 'desc' },
    include: {
      paymentHistory: {
        orderBy: { createdAt: 'asc' },
        select: { id: true, amount: true, balanceAfter: true, note: true, createdAt: true },
      },
    },
  });

  const ledgerPurchases = purchases.map(p => ({
    id: p.id,
    invoiceNumber: p.invoiceNumber,
    date: p.createdAt,
    total: Number(p.total),
    paid: Number(p.paid),
    due: Math.max(0, Number(p.total) - Number(p.paid)),
    status: p.status,
    createdAt: p.createdAt,
    paymentHistory: (p.paymentHistory ?? []).map(ph => ({
      id: ph.id,
      amount: Number(ph.amount),
      balanceAfter: Number(ph.balanceAfter),
      note: ph.note,
      createdAt: ph.createdAt,
    })),
  }));

  const totalPurchases = ledgerPurchases.reduce((s, p) => s + p.total, 0);
  const totalPaid = ledgerPurchases.reduce((s, p) => s + p.paid, 0);
  const totalDue = Math.max(0, totalPurchases - totalPaid);

  return res.json(ApiResponse.success({
    supplier: mapSupplier(supplier),
    totalPurchases,
    totalPaid,
    totalDue,
    purchases: ledgerPurchases,
  }));
});

