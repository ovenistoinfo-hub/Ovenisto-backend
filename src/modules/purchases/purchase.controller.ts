/**
 * Purchase Controller — Phase 7
 */
import type { Request, Response } from 'express';
import { prisma } from '../../config/database.js';
import { ApiResponse } from '../../utils/ApiResponse.js';
import { ApiError } from '../../utils/ApiError.js';
import { asyncHandler } from '../../utils/asyncHandler.js';

function mapPurchase(p: any) {
  return {
    ...p,
    subtotal: p.subtotal != null ? Number(p.subtotal) : null,
    tax: p.tax != null ? Number(p.tax) : null,
    total: p.total != null ? Number(p.total) : null,
    paid: Number(p.paid),
    due: Number(p.due),
    supplierName: p.supplier?.name ?? null,
    supplier: undefined,
  };
}

export const getPurchases = asyncHandler(async (req: Request, res: Response) => {
  const { page = '1', limit = '20', supplierId, status } = req.query as Record<string, string>;
  const skip = (Number(page) - 1) * Number(limit);

  const where: any = {};
  if (supplierId) where.supplierId = supplierId;
  if (status) where.status = status;

  const [data, total] = await Promise.all([
    prisma.purchase.findMany({
      where,
      skip,
      take: Number(limit),
      orderBy: { createdAt: 'desc' },
      include: { supplier: { select: { name: true } } },
    }),
    prisma.purchase.count({ where }),
  ]);

  return res.json(ApiResponse.paginated(data.map(mapPurchase), Number(page), Number(limit), total));
});

export const getPurchase = asyncHandler(async (req: Request, res: Response) => {
  const p = await prisma.purchase.findUnique({
    where: { id: req.params.id },
    include: { supplier: { select: { name: true } } },
  });
  if (!p) throw new ApiError('Purchase not found', 404);
  return res.json(ApiResponse.success(mapPurchase(p)));
});

export const createPurchase = asyncHandler(async (req: Request, res: Response) => {
  const { supplierId, invoiceNumber, date, items, subtotal, tax, total, paid, status, notes } = req.body;

  if (!items || !Array.isArray(items) || items.length === 0) {
    throw new ApiError('Purchase items are required', 400);
  }
  if (total == null) throw new ApiError('Total amount is required', 400);
  if (!status) throw new ApiError('Payment status is required', 400);

  const paidAmount = Number(paid ?? 0);
  const totalAmount = Number(total);
  const due =
    status === 'paid' ? 0 :
    status === 'unpaid' ? totalAmount :
    totalAmount - paidAmount;

  const purchase = await prisma.$transaction(async (tx) => {
    // Step 1: Create purchase record
    const p = await tx.purchase.create({
      data: {
        supplierId: supplierId || null,
        invoiceNumber: invoiceNumber || null,
        date: date ? new Date(date) : new Date(),
        items,
        subtotal: subtotal != null ? subtotal : null,
        tax: tax != null ? tax : null,
        total: totalAmount,
        paid: paidAmount,
        due,
        status,
        notes: notes || null,
      },
      include: { supplier: { select: { name: true } } },
    });

    // Step 2: Update ingredient stock + purchase price for each item
    for (const item of items) {
      if (item.ingredientId) {
        await tx.ingredient.update({
          where: { id: item.ingredientId },
          data: {
            currentStock: { increment: Number(item.qty) },
            purchasePrice: Number(item.unitPrice),
          },
        });
      }
    }

    // Step 3: Update supplier totals if supplierId provided
    if (supplierId) {
      await tx.supplier.update({
        where: { id: supplierId },
        data: {
          totalPurchases: { increment: totalAmount },
          totalDue: { increment: due },
        },
      });
    }

    return p;
  });

  return res.status(201).json(ApiResponse.created(mapPurchase(purchase), 'Purchase created'));
});

export const updatePurchase = asyncHandler(async (req: Request, res: Response) => {
  const { paid, status } = req.body;

  const existing = await prisma.purchase.findUnique({ where: { id: req.params.id } });
  if (!existing) throw new ApiError('Purchase not found', 404);

  const totalAmount = Number(existing.total ?? 0);
  const paidAmount = Number(paid ?? 0);
  const newDue =
    status === 'paid' ? 0 :
    status === 'unpaid' ? totalAmount :
    totalAmount - paidAmount;
  const dueDiff = newDue - Number(existing.due);

  const updated = await prisma.$transaction(async (tx) => {
    const p = await tx.purchase.update({
      where: { id: req.params.id },
      data: { paid: paidAmount, due: newDue, status },
      include: { supplier: { select: { name: true } } },
    });

    if (existing.supplierId && dueDiff !== 0) {
      await tx.supplier.update({
        where: { id: existing.supplierId },
        data: { totalDue: { increment: dueDiff } },
      });
    }

    return p;
  });

  return res.json(ApiResponse.success(mapPurchase(updated), 'Purchase updated'));
});

export const deletePurchase = asyncHandler(async (req: Request, res: Response) => {
  const existing = await prisma.purchase.findUnique({ where: { id: req.params.id } });
  if (!existing) throw new ApiError('Purchase not found', 404);

  const items = (existing.items as any[]) || [];

  await prisma.$transaction(async (tx) => {
    // Reverse ingredient stock
    for (const item of items) {
      if (item.ingredientId) {
        const ing = await tx.ingredient.findUnique({ where: { id: item.ingredientId } });
        if (ing) {
          await tx.ingredient.update({
            where: { id: item.ingredientId },
            data: {
              currentStock: Math.max(0, Number(ing.currentStock) - Number(item.qty)),
            },
          });
        }
      }
    }

    // Reverse supplier totals
    if (existing.supplierId) {
      await tx.supplier.update({
        where: { id: existing.supplierId },
        data: {
          totalPurchases: { decrement: Number(existing.total ?? 0) },
          totalDue: { decrement: Number(existing.due) },
        },
      });
    }

    await tx.purchase.delete({ where: { id: req.params.id } });
  });

  return res.json(ApiResponse.success(null, 'Purchase deleted'));
});
