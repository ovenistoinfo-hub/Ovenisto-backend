/**
 * Purchase Controller — Phase 7
 */
import type { Request, Response } from 'express';
import { prisma } from '../../config/database.js';
import { ApiResponse } from '../../utils/ApiResponse.js';
import { ApiError } from '../../utils/ApiError.js';
import { asyncHandler } from '../../utils/asyncHandler.js';
import { resolveOutletScope, resolveCreateOutlet } from '../../middleware/outletScope.js';
import { emitPurchaseEvent } from '../../socket.js';

function mapPurchase(p: any) {
  return {
    ...p,
    subtotal: p.subtotal != null ? Number(p.subtotal) : null,
    discount: Number(p.discount ?? 0),
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
    paymentHistory: (p.paymentHistory ?? []).map((ph: any) => ({
      id: ph.id,
      amount: Number(ph.amount),
      balanceAfter: Number(ph.balanceAfter),
      note: ph.note,
      createdAt: ph.createdAt,
      supplierId: ph.supplierId,
    })),
    supplierDues: p.supplierDues != null ? (p.supplierDues as any[]).map((sd: any) => ({
      ...sd,
      total: Number(sd.total ?? 0),
      paid: Number(sd.paid ?? 0),
      due: Number(sd.due ?? 0),
    })) : null,
    supplier: undefined,
    warehouse: undefined,
  };
}

export interface PurchaseOutletShape {
  outletId: string | null;
  warehouseId: string | null;
  warehouse?: { outletId: string | null } | null;
}

/**
 * The outlet a purchase actually belongs to.
 *
 * A warehouse-linked purchase belongs to its WAREHOUSE's outlet — its own
 * `outletId` column is not the authority for those rows. Only a purchase with no
 * warehouse falls back to the column. Exported and used by BOTH the access check
 * and the socket emit so the two can never drift: if they disagreed, an event
 * would be delivered to an outlet that cannot open the row (or vice versa).
 */
export function getPurchaseOutletId(purchase: PurchaseOutletShape): string | null {
  const warehouseOutletId = purchase.warehouse ? purchase.warehouse.outletId : undefined;
  return purchase.warehouseId ? (warehouseOutletId ?? null) : purchase.outletId;
}

function checkPurchaseAccess(req: Request, purchase: PurchaseOutletShape) {
  const isSuperAdmin = req.user?.role === 'Super Admin';
  const effectiveOutletId = getPurchaseOutletId(purchase);

  if (isSuperAdmin) {
    if (effectiveOutletId !== null) {
      throw new ApiError('Purchase not found', 404);
    }
  } else {
    const scope = resolveOutletScope(req);
    if (scope && effectiveOutletId !== scope) {
      throw new ApiError('Purchase not found', 404);
    }
  }
}

export const getPurchases = asyncHandler(async (req: Request, res: Response) => {
  const { page = '1', limit = '20', supplierId, status } = req.query as Record<string, string>;
  const skip = (Number(page) - 1) * Number(limit);

  const where: any = {};
  if (supplierId) where.supplierId = supplierId;
  if (status) where.status = status;

  const scope = resolveOutletScope(req);
  if (req.user?.role === 'Super Admin') {
    where.OR = [
      { warehouse: { outletId: null } },
      { AND: [ { warehouseId: null }, { outletId: null } ] }
    ];
  } else if (scope) {
    where.OR = [
      { warehouse: { outletId: scope } },
      { AND: [ { warehouseId: null }, { outletId: scope } ] }
    ];
  }

  const [data, total] = await Promise.all([
    prisma.purchase.findMany({
      where,
      skip,
      take: Number(limit),
      orderBy: { createdAt: 'desc' },
      include: {
        supplier: { select: { name: true } },
        warehouse: { select: { name: true, outletId: true } },
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
      warehouse: { select: { name: true, outletId: true } },
      createdBy: { select: { name: true, role: true, phone: true, email: true } },
      paymentHistory: { orderBy: { createdAt: 'asc' } },
    },
  });
  if (!p) throw new ApiError('Purchase not found', 404);
  checkPurchaseAccess(req, p);
  return res.json(ApiResponse.success(mapPurchase(p)));
});

export const createPurchase = asyncHandler(async (req: Request, res: Response) => {
  const {
    supplierId, invoiceNumber, date, items, subtotal, discount, tax,
    shippingCost, miscAmount,
    total, paid, status, notes, warehouseId, purchaseRequestId,
    supplierDues,
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

  let outletId: string | null = null;
  if (warehouseId) {
    const pWarehouse = await prisma.warehouse.findUnique({ where: { id: warehouseId }, select: { outletId: true, type: true } });
    if (!pWarehouse) throw new ApiError('Warehouse not found', 404);
    
    const isSuperAdmin = req.user?.role === 'Super Admin';
    if (isSuperAdmin && pWarehouse.type !== 'MAIN') {
      throw new ApiError('Super Admin can only record purchases for the Main Warehouse', 400);
    }
    if (!isSuperAdmin && pWarehouse.type !== 'BRANCH') {
      throw new ApiError('Branch users can only record purchases for branch warehouses', 400);
    }
    outletId = pWarehouse.outletId;
  } else {
    const isSuperAdmin = req.user?.role === 'Super Admin';
    if (isSuperAdmin) {
      // Find the main warehouse to link to by default if no warehouse is provided
      const mainWh = await prisma.warehouse.findFirst({ where: { type: 'MAIN' } });
      if (!mainWh) throw new ApiError('Main warehouse not found in system', 400);
      throw new ApiError('Super Admin must specify the Main Warehouse for purchases', 400);
    }
    outletId = resolveCreateOutlet(req);
  }

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
        discount: Number(discount ?? 0),
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
        supplierDues: supplierDues || null,
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

    // Step 2b: Record purchase-time waste in the Waste section so it is trackable.
    // The wasted qty never entered stock (receivedQty = qty - wasteQty above), so this is
    // tracking ONLY — do NOT deduct stock again here. Linked via purchaseId so the record
    // is removed if the purchase is deleted (see deletePurchase).
    for (const item of items) {
      const wasteQty = Number(item.wasteQty ?? 0);
      if (wasteQty > 0) {
        await tx.wasteRecord.create({
          data: {
            itemName: String(item.name || 'Ingredient').slice(0, 100),
            quantity: wasteQty,
            unit: item.unit || null,
            reason: String(item.wasteReason ?? '').trim() || 'Wasted at purchase receiving',
            cost: wasteQty * Number(item.unitPrice ?? 0),
            recordedBy: (req as any).user?.name || null,
            outletId,
            purchaseId: p.id,
            date: p.date,
          },
        });
      }
    }

    // Step 3: Update supplier totals if supplierDues or supplierId provided
    if (supplierDues && Array.isArray(supplierDues)) {
      for (const sd of supplierDues) {
        if (sd.supplierId) {
          await tx.supplier.update({
            where: { id: sd.supplierId },
            data: {
              totalPurchases: { increment: Number(sd.total) },
              totalDue: { increment: Number(sd.due) },
            },
          });
        }
      }
    } else if (supplierId) {
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

    // Step 5: Create initial PurchasePayment ledger entry if any amount was paid
    if (supplierDues && Array.isArray(supplierDues)) {
      for (const sd of supplierDues) {
        if (sd.supplierId && Number(sd.paid) > 0) {
          await tx.purchasePayment.create({
            data: {
              purchaseId: p.id,
              supplierId: sd.supplierId,
              amount: Number(sd.paid),
              balanceAfter: Number(sd.due),
              note: `Initial payment at purchase creation (${sd.supplierName || 'Supplier'})`,
              recordedById: (req as any).user?.id || null,
            },
          });
        }
      }
    } else if (paidAmount > 0) {
      await tx.purchasePayment.create({
        data: {
          purchaseId: p.id,
          amount: paidAmount,
          balanceAfter: due,
          note: 'Initial payment at purchase creation',
          recordedById: (req as any).user?.id || null,
        },
      });
    }

    return p;
  }, { timeout: 30000 });

  const created = mapPurchase(purchase);
  emitPurchaseEvent('purchase:created', created, [outletId]);
  return res.status(201).json(ApiResponse.created(created, 'Purchase created'));
});

export const updatePurchase = asyncHandler(async (req: Request, res: Response) => {
  const { paid, status } = req.body;

  const existing = await prisma.purchase.findUnique({
    where: { id: req.params.id },
    include: { warehouse: { select: { outletId: true } } }
  });
  if (!existing) throw new ApiError('Purchase not found', 404);
  checkPurchaseAccess(req, existing);

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

  const updatedPayload = mapPurchase(updated);
  emitPurchaseEvent('purchase:updated', updatedPayload, [getPurchaseOutletId(existing)]);
  return res.json(ApiResponse.success(updatedPayload, 'Purchase updated'));
});

export const deletePurchase = asyncHandler(async (req: Request, res: Response) => {
  const existing = await prisma.purchase.findUnique({
    where: { id: req.params.id },
    include: { warehouse: { select: { outletId: true } } }
  });
  if (!existing) throw new ApiError('Purchase not found', 404);
  checkPurchaseAccess(req, existing);

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
    if (existing.supplierDues && Array.isArray(existing.supplierDues)) {
      for (const sd of existing.supplierDues as any[]) {
        if (sd.supplierId) {
          await tx.supplier.update({
            where: { id: sd.supplierId },
            data: {
              totalPurchases: { decrement: Number(sd.total) },
              totalDue: { decrement: Number(sd.due) },
            },
          });
        }
      }
    } else if (existing.supplierId) {
      await tx.supplier.update({
        where: { id: existing.supplierId },
        data: {
          totalPurchases: { decrement: Number(existing.total ?? 0) },
          totalDue: { decrement: Number(existing.due) },
        },
      });
    }

    // Remove the waste records this purchase created (linked via purchaseId) so the
    // Waste section stays consistent with the purchase being gone.
    await tx.wasteRecord.deleteMany({ where: { purchaseId: existing.id } });

    await tx.purchase.delete({ where: { id: req.params.id } });
  });

  emitPurchaseEvent('purchase:deleted', { id: req.params.id }, [getPurchaseOutletId(existing)]);
  return res.json(ApiResponse.success(null, 'Purchase deleted'));
});

export const payPurchase = asyncHandler(async (req: Request, res: Response) => {
  const { id } = req.params;
  const { amount, note, supplierId } = req.body;

  const payAmount = Number(amount);
  if (!payAmount || payAmount <= 0) {
    throw new ApiError('Valid payment amount required', 400);
  }

  const existing = await prisma.purchase.findUnique({
    where: { id },
    include: { warehouse: { select: { outletId: true } } }
  });
  if (!existing) throw new ApiError('Purchase not found', 404);
  checkPurchaseAccess(req, existing);

  // If there are multiple supplier dues in this purchase
  let updatedSupplierDues: any = null;
  let targetSupplierId = supplierId || existing.supplierId;
  let currentDue = 0;
  let newPaid = 0;
  let newDue = 0;

  if (existing.supplierDues && Array.isArray(existing.supplierDues)) {
    const dues = existing.supplierDues as any[];
    // Find the due entry for the target supplier
    let targetEntry = dues.find(d => d.supplierId === targetSupplierId);
    if (!targetEntry) {
      // If we didn't specify supplierId but there's only one supplier in dues, use that
      const validDues = dues.filter(d => d.supplierId);
      if (!targetSupplierId && validDues.length === 1) {
        targetSupplierId = validDues[0].supplierId;
        targetEntry = validDues[0];
      } else {
        throw new ApiError('Supplier ID is required for multi-supplier purchases', 400);
      }
    }

    currentDue = Number(targetEntry.due);
    if (currentDue <= 0) {
      throw new ApiError('This supplier has no outstanding balance on this purchase', 400);
    }
    if (payAmount > currentDue) {
      throw new ApiError(`Payment amount (${payAmount}) cannot exceed supplier due (${currentDue})`, 400);
    }

    // Update this supplier's entry
    targetEntry.paid = Number(targetEntry.paid) + payAmount;
    targetEntry.due = currentDue - payAmount;
    targetEntry.status = targetEntry.due <= 0 ? 'paid' : 'partial';
    updatedSupplierDues = dues;

    // Recalculate overall paid and due
    newDue = dues.reduce((sum, d) => sum + Number(d.due), 0);
    newPaid = Number(existing.total) - newDue;
  } else {
    // Fallback old single-supplier logic
    currentDue = Number(existing.due);
    if (currentDue <= 0) {
      throw new ApiError('This purchase has no outstanding balance', 400);
    }
    if (payAmount > currentDue) {
      throw new ApiError(`Payment amount (${payAmount}) cannot exceed outstanding due (${currentDue})`, 400);
    }
    newPaid = Number(existing.paid) + payAmount;
    newDue = currentDue - payAmount;
  }

  const newStatus = newDue <= 0 ? 'paid' : 'partial';

  const updated = await prisma.$transaction(async (tx) => {
    // Update purchase financials
    const p = await tx.purchase.update({
      where: { id },
      data: {
        paid: newPaid,
        due: newDue,
        status: newStatus,
        ...(updatedSupplierDues && { supplierDues: updatedSupplierDues })
      },
      include: {
        supplier: { select: { name: true } },
        warehouse: { select: { name: true } },
        createdBy: { select: { name: true, role: true, phone: true, email: true } },
        paymentHistory: { orderBy: { createdAt: 'asc' } },
      },
    });

    // Create payment ledger entry
    await tx.purchasePayment.create({
      data: {
        purchaseId: id,
        supplierId: targetSupplierId || null,
        amount: payAmount,
        balanceAfter: newDue,
        note: note || null,
        recordedById: (req as any).user?.id || null,
      },
    });

    // Update supplier totalDue if targetSupplierId is linked
    if (targetSupplierId) {
      await tx.supplier.update({
        where: { id: targetSupplierId },
        data: { totalDue: { decrement: payAmount } },
      });
    }

    return p;
  });

  const updatedPayload = mapPurchase(updated);
  emitPurchaseEvent('purchase:updated', updatedPayload, [getPurchaseOutletId(existing)]);
  return res.json(ApiResponse.success(updatedPayload, 'Payment recorded'));
});

export const getPurchaseStats = asyncHandler(async (req: Request, res: Response) => {
  const { supplierId } = req.query as Record<string, string>;

  const where: any = {};
  if (supplierId) where.supplierId = supplierId;

  const scope = resolveOutletScope(req);
  if (req.user?.role === 'Super Admin') {
    where.OR = [
      { warehouse: { outletId: null } },
      { AND: [ { warehouseId: null }, { outletId: null } ] }
    ];
  } else if (scope) {
    where.OR = [
      { warehouse: { outletId: scope } },
      { AND: [ { warehouseId: null }, { outletId: scope } ] }
    ];
  }

  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  
  const startOfWeek = new Date(now);
  startOfWeek.setDate(now.getDate() - ((now.getDay() + 6) % 7));
  const weekStart = new Date(startOfWeek.getFullYear(), startOfWeek.getMonth(), startOfWeek.getDate());

  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

  const [totalAgg, todayAgg, weeklyAgg, monthlyAgg] = await Promise.all([
    prisma.purchase.aggregate({
      where,
      _sum: { total: true },
    }),
    prisma.purchase.aggregate({
      where: {
        ...where,
        createdAt: { gte: todayStart },
      },
      _sum: { total: true },
    }),
    prisma.purchase.aggregate({
      where: {
        ...where,
        createdAt: { gte: weekStart },
      },
      _sum: { total: true },
    }),
    prisma.purchase.aggregate({
      where: {
        ...where,
        createdAt: { gte: monthStart },
      },
      _sum: { total: true },
    }),
  ]);

  return res.json(ApiResponse.success({
    total: Number(totalAgg._sum.total || 0),
    today: Number(todayAgg._sum.total || 0),
    weekly: Number(weeklyAgg._sum.total || 0),
    monthly: Number(monthlyAgg._sum.total || 0),
  }));
});
