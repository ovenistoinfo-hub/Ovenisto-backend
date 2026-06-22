/**
 * Purchase Controller — Phase 7
 */
import type { Request, Response } from 'express';
import { prisma } from '../../config/database.js';
import { ApiResponse } from '../../utils/ApiResponse.js';
import { ApiError } from '../../utils/ApiError.js';
import { asyncHandler } from '../../utils/asyncHandler.js';
import { resolveOutletScope, resolveCreateOutlet } from '../../middleware/outletScope.js';

function mapPurchase(p: any) {
  return {
    ...p,
    subtotal: p.subtotal != null ? Number(p.subtotal) : null,
    tax: p.tax != null ? Number(p.tax) : null,
    shippingCost: p.shippingCost != null ? Number(p.shippingCost) : null,
    miscAmount: p.miscAmount != null ? Number(p.miscAmount) : null,
    total: p.total != null ? Number(p.total) : null,
    paid: Number(p.paid),
    due: Number(p.due),
    supplierName: p.supplier?.name ?? null,
    warehouseName: p.warehouse?.name ?? null,
    createdByName: p.createdBy?.name ?? null,
    createdByRole: p.createdBy?.role ?? null,
    createdByPhone: p.createdBy?.phone ?? null,
    createdByEmail: p.createdBy?.email ?? null,
    supplier: undefined,
    warehouse: undefined,
    createdBy: undefined,
  };
}

export const getPurchases = asyncHandler(async (req: Request, res: Response) => {
  const { page = '1', limit = '20', supplierId, status } = req.query as Record<string, string>;
  const skip = (Number(page) - 1) * Number(limit);

  const where: any = {};
  if (supplierId) where.supplierId = supplierId;
  if (status) where.status = status;

  const scope = resolveOutletScope(req);
  if (scope) where.outletId = scope;

  const [data, total] = await Promise.all([
    prisma.purchase.findMany({
      where,
      skip,
      take: Number(limit),
      orderBy: { createdAt: 'desc' },
      include: {
        supplier: { select: { name: true } },
        warehouse: { select: { name: true } },
        createdBy: { select: { name: true, role: true, phone: true, email: true } },
      },
    }),
    prisma.purchase.count({ where }),
  ]);

  return res.json(ApiResponse.paginated(data.map(mapPurchase), Number(page), Number(limit), total));
});

export const getPurchase = asyncHandler(async (req: Request, res: Response) => {
  const p = await prisma.purchase.findUnique({
    where: { id: req.params.id },
    include: {
      supplier: { select: { name: true } },
      warehouse: { select: { name: true } },
    },
  });
  if (!p) throw new ApiError('Purchase not found', 404);
  const scope = resolveOutletScope(req);
  if (scope && p.outletId !== scope) throw new ApiError('Purchase not found', 404);
  return res.json(ApiResponse.success(mapPurchase(p)));
});

export const createPurchase = asyncHandler(async (req: Request, res: Response) => {
  const {
    supplierId, invoiceNumber, date, items, subtotal, tax,
    shippingCost, miscAmount,
    total, paid, status, notes, warehouseId, purchaseRequestId,
  } = req.body;

  if (!items || !Array.isArray(items) || items.length === 0) {
    throw new ApiError('Purchase items are required', 400);
  }
  if (total == null) throw new ApiError('Total amount is required', 400);
  if (!status) throw new ApiError('Payment status is required', 400);

  // Validate purchase request if provided
  if (purchaseRequestId) {
    const pr = await prisma.purchaseRequest.findUnique({ where: { id: purchaseRequestId } });
    if (!pr) throw new ApiError('Purchase request not found', 404);
    if (pr.status !== 'APPROVED') throw new ApiError('Purchase request is not approved', 400);
  }

  const pWarehouse = warehouseId
    ? await prisma.warehouse.findUnique({ where: { id: warehouseId }, select: { outletId: true } })
    : null;
  const outletId = resolveCreateOutlet(req, pWarehouse?.outletId);

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
        shippingCost: shippingCost != null ? shippingCost : null,
        miscAmount: miscAmount != null ? miscAmount : null,
        total: totalAmount,
        paid: paidAmount,
        due,
        status,
        notes: notes || null,
        warehouseId: warehouseId || null,
        outletId,
        purchaseRequestId: purchaseRequestId || null,
        createdById: (req as any).user?.id || null,
      },
      include: {
        supplier: { select: { name: true } },
        warehouse: { select: { name: true } },
        createdBy: { select: { name: true, role: true, phone: true, email: true } },
      },
    });

    // Step 2: Update ingredient stock + purchase price AND warehouse stock
    // receivedQty = purchased qty - waste qty (what actually enters stock)
    for (const item of items) {
      if (item.ingredientId) {
        const receivedQty = Number(item.qty) - Number(item.wasteQty ?? 0);

        // Keep global ingredient stock in sync (only received qty goes to stock)
        const ing = await tx.ingredient.update({
          where: { id: item.ingredientId },
          data: {
            currentStock: { increment: receivedQty },
            purchasePrice: Number(item.unitPrice),
          },
        });

        // Write to WarehouseStock if warehouseId provided
        if (warehouseId) {
          await tx.warehouseStock.upsert({
            where: { warehouseId_ingredientId: { warehouseId, ingredientId: item.ingredientId } },
            update: { currentStock: { increment: receivedQty } },
            create: {
              warehouseId,
              ingredientId: item.ingredientId,
              currentStock: receivedQty,
              lowStockLevel: Number(ing.lowStockLevel),
            },
          });

          // Create StockBatch for expiry tracking (only received qty)
          if (receivedQty > 0) {
            await tx.stockBatch.create({
              data: {
                warehouseId,
                ingredientId: item.ingredientId,
                purchaseId: p.id,
                batchQty: receivedQty,
                remainingQty: receivedQty,
                expiryDate: item.expiryDate ? new Date(item.expiryDate) : null,
              },
            });
          }
        }
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

    // Step 4: Mark purchase request as PURCHASED if linked
    if (purchaseRequestId) {
      await tx.purchaseRequest.update({
        where: { id: purchaseRequestId },
        data: { status: 'PURCHASED' },
      });
    }

    return p;
  }, { timeout: 30000 });

  return res.status(201).json(ApiResponse.created(mapPurchase(purchase), 'Purchase created'));
});

export const updatePurchase = asyncHandler(async (req: Request, res: Response) => {
  const { paid, status } = req.body;

  const existing = await prisma.purchase.findUnique({ where: { id: req.params.id } });
  if (!existing) throw new ApiError('Purchase not found', 404);
  const scope = resolveOutletScope(req);
  if (scope && existing.outletId !== scope) throw new ApiError('Purchase not found', 404);

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
      include: {
        supplier: { select: { name: true } },
        warehouse: { select: { name: true } },
        createdBy: { select: { name: true, role: true, phone: true, email: true } },
      },
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
  const scope = resolveOutletScope(req);
  if (scope && existing.outletId !== scope) throw new ApiError('Purchase not found', 404);

  const items = (existing.items as any[]) || [];

  await prisma.$transaction(async (tx) => {
    // Reverse ingredient stock (use receivedQty = qty - wasteQty, same as what was added)
    for (const item of items) {
      if (item.ingredientId) {
        const receivedQty = Number(item.qty) - Number(item.wasteQty ?? 0);

        const ing = await tx.ingredient.findUnique({ where: { id: item.ingredientId } });
        if (ing) {
          await tx.ingredient.update({
            where: { id: item.ingredientId },
            data: {
              currentStock: Math.max(0, Number(ing.currentStock) - receivedQty),
            },
          });
        }

        // Reverse WarehouseStock if purchase had a warehouse
        if (existing.warehouseId && item.ingredientId) {
          const ws = await tx.warehouseStock.findUnique({
            where: { warehouseId_ingredientId: { warehouseId: existing.warehouseId, ingredientId: item.ingredientId } },
          });
          if (ws) {
            await tx.warehouseStock.update({
              where: { warehouseId_ingredientId: { warehouseId: existing.warehouseId, ingredientId: item.ingredientId } },
              data: { currentStock: { decrement: receivedQty } },
            });
          }
        }

        // Reverse StockBatch records created by this purchase
        if (existing.id) {
          await tx.stockBatch.deleteMany({
            where: { purchaseId: existing.id, ingredientId: item.ingredientId },
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
