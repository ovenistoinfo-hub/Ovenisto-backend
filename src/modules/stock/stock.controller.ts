/**
 * Stock Controller
 * Phase 4: Stock Adjustments, Stock Takes, Production, Transfers, Waste Records
 */

import type { Request, Response } from 'express';
import { prisma } from '../../config/database.js';
import { ApiResponse } from '../../utils/ApiResponse.js';
import { ApiError } from '../../utils/ApiError.js';
import { asyncHandler } from '../../utils/asyncHandler.js';
import { effectiveExpiry, minutesRemaining, batchStatus } from './dough.helpers.js';
import { resolveCreateOutlet, resolveOutletScope } from '../../middleware/outletScope.js';

// ============================================================
// STOCK ADJUSTMENTS
// ============================================================

/** GET /api/stock/adjustments */
export const getAdjustments = asyncHandler(async (req: Request, res: Response) => {
  const { search, warehouseId, page = '1', limit = '50' } = req.query;
  const skip = (Number(page) - 1) * Number(limit);

  const where: any = {};
  if (search) where.ingredient = { name: { contains: String(search), mode: 'insensitive' } };
  if (warehouseId) where.warehouseId = String(warehouseId);
  const scope = resolveOutletScope(req);
  if (scope) where.outletId = scope;

  const [adjustments, total] = await Promise.all([
    prisma.stockAdjustment.findMany({
      where,
      skip,
      take: Number(limit),
      orderBy: { date: 'desc' },
      include: {
        ingredient: { select: { id: true, name: true, unit: { select: { name: true, symbol: true } }, category: { select: { name: true } } } },
        adjustedBy: { select: { id: true, name: true, phone: true, role: true, outlet: { select: { name: true } } } },
        warehouse: { select: { id: true, name: true, type: true } },
      },
    }),
    prisma.stockAdjustment.count({ where }),
  ]);

  res.json(ApiResponse.paginated(adjustments, Number(page), Number(limit), total));
});

/** POST /api/stock/adjustments */
export const createAdjustment = asyncHandler(async (req: Request, res: Response) => {
  const { ingredientId, type, quantity, reason, warehouseId } = req.body;

  if (!ingredientId) throw ApiError.badRequest('Ingredient is required');
  if (!quantity || Number(quantity) <= 0) throw ApiError.badRequest('Quantity must be greater than 0');
  if (!type) throw ApiError.badRequest('Type is required');

  const validTypes = ['add', 'deduct', 'damage', 'correction'];
  if (!validTypes.includes(type)) throw ApiError.badRequest(`Type must be one of: ${validTypes.join(', ')}`);

  const ingredient = await prisma.ingredient.findUnique({ where: { id: ingredientId } });
  if (!ingredient) throw ApiError.notFound('Ingredient not found');

  const adjWarehouse = warehouseId
    ? await prisma.warehouse.findUnique({ where: { id: warehouseId }, select: { outletId: true } })
    : null;
  const outletId = resolveCreateOutlet(req, adjWarehouse?.outletId);

  const adjustedById = req.user?.id;
  const stockChange = ['add', 'correction'].includes(type) ? Number(quantity) : -Number(quantity);

  const adjustment = await prisma.$transaction(async (tx) => {
    const adj = await tx.stockAdjustment.create({
      data: {
        ingredientId,
        type,
        quantity: Number(quantity),
        reason: reason || null,
        adjustedById: adjustedById || null,
        warehouseId: warehouseId || null,
        outletId,
        date: new Date(),
      },
      include: {
        ingredient: { select: { id: true, name: true, unit: { select: { name: true, symbol: true } }, category: { select: { name: true } } } },
        adjustedBy: { select: { id: true, name: true, phone: true, role: true, outlet: { select: { name: true } } } },
        warehouse: { select: { id: true, name: true, type: true } },
      },
    });

    // Update global ingredient stock
    await tx.ingredient.update({
      where: { id: ingredientId },
      data: { currentStock: { increment: stockChange } },
    });

    // Update warehouse-specific stock if warehouseId provided
    if (warehouseId) {
      await tx.warehouseStock.upsert({
        where: { warehouseId_ingredientId: { warehouseId, ingredientId } },
        update: { currentStock: { increment: stockChange } },
        create: {
          warehouseId,
          ingredientId,
          currentStock: Math.max(0, stockChange),
          lowStockLevel: Number(ingredient.lowStockLevel),
        },
      });
    }

    return adj;
  }, { timeout: 60000 });

  res.status(201).json(ApiResponse.created(adjustment, 'Stock adjustment recorded'));
});

// ============================================================
// STOCK TAKES
// ============================================================

/** GET /api/stock/takes */
export const getStockTakes = asyncHandler(async (req: Request, res: Response) => {
  const scope = resolveOutletScope(req);
  const takes = await prisma.stockTake.findMany({
    where: scope ? { outletId: scope } : {},
    orderBy: { createdAt: 'desc' },
    include: { items: { include: { ingredient: { select: { id: true, name: true, unit: { select: { name: true } } } } } } },
  });
  res.json(ApiResponse.success(takes));
});

/** GET /api/stock/takes/:id */
export const getStockTake = asyncHandler(async (req: Request, res: Response) => {
  const take = await prisma.stockTake.findUnique({
    where: { id: req.params.id },
    include: { items: { include: { ingredient: { select: { id: true, name: true, unit: { select: { name: true } } } } } } },
  });
  if (!take) throw ApiError.notFound('Stock take not found');
  const scope = resolveOutletScope(req);
  if (scope && take.outletId !== scope) throw ApiError.notFound('Stock take not found');
  res.json(ApiResponse.success(take));
});

/** POST /api/stock/takes - start a new stock take (captures system quantities) */
export const startStockTake = asyncHandler(async (req: Request, res: Response) => {
  const { notes } = req.body;
  const outletId = resolveCreateOutlet(req);

  const ingredients = await prisma.ingredient.findMany({
    where: { status: 'active' },
    select: { id: true, currentStock: true },
  });

  const count = await prisma.stockTake.count();
  const reference = `ST-${String(count + 1).padStart(3, '0')}`;

  const take = await prisma.stockTake.create({
    data: {
      reference,
      date: new Date(),
      status: 'active',
      countedBy: req.user?.name || null,
      notes: notes || null,
      outletId,
      items: {
        create: ingredients.map((ing) => ({
          ingredientId: ing.id,
          systemQty: Number(ing.currentStock),
          countedQty: null,
          variance: null,
          varianceValue: null,
        })),
      },
    },
    include: { items: { include: { ingredient: { select: { id: true, name: true, unit: { select: { name: true } } } } } } },
  });

  res.status(201).json(ApiResponse.created(take, 'Stock take started'));
});

/** POST /api/stock/takes/:id/complete - submit counted quantities and adjust stock */
export const completeStockTake = asyncHandler(async (req: Request, res: Response) => {
  const { id } = req.params;
  const { items } = req.body; // [{ ingredientId, countedQty }]

  const take = await prisma.stockTake.findUnique({ where: { id } });
  if (!take) throw ApiError.notFound('Stock take not found');
  const scope = resolveOutletScope(req);
  if (scope && take.outletId !== scope) throw ApiError.notFound('Stock take not found');
  if (take.status === 'completed') throw ApiError.badRequest('Stock take already completed');

  if (!items?.length) throw ApiError.badRequest('Counted items are required');

  const result = await prisma.$transaction(async (tx) => {
    let totalVarianceValue = 0;

    for (const item of items) {
      const ingredient = await tx.ingredient.findUnique({
        where: { id: item.ingredientId },
        select: { currentStock: true, purchasePrice: true },
      });
      if (!ingredient) continue;

      const systemQty = Number(ingredient.currentStock);
      const countedQty = Number(item.countedQty);
      const variance = countedQty - systemQty;
      const varianceValue = variance * Number(ingredient.purchasePrice || 0);
      totalVarianceValue += varianceValue;

      // Update stock take item
      await tx.stockTakeItem.updateMany({
        where: { stockTakeId: id, ingredientId: item.ingredientId },
        data: { countedQty, variance, varianceValue, systemQty },
      });

      // Adjust ingredient stock if variance exists
      if (variance !== 0) {
        await tx.ingredient.update({
          where: { id: item.ingredientId },
          data: { currentStock: countedQty },
        });
      }
    }

    return tx.stockTake.update({
      where: { id },
      data: {
        status: 'completed',
        totalVarianceValue,
        completedAt: new Date(),
      },
      include: { items: { include: { ingredient: { select: { id: true, name: true, unit: { select: { name: true } } } } } } },
    });
  }, { timeout: 60000 });

  res.json(ApiResponse.success(result, 'Stock take completed'));
});

// ============================================================
// PRODUCTION
// ============================================================

/** GET /api/stock/productions */
export const getProductions = asyncHandler(async (req: Request, res: Response) => {
  const { search, page = '1', limit = '50' } = req.query;
  const skip = (Number(page) - 1) * Number(limit);

  const where: any = {};
  if (search) where.itemName = { contains: String(search), mode: 'insensitive' };
  const scope = resolveOutletScope(req);
  if (scope) where.outletId = scope;

  const [productions, total] = await Promise.all([
    prisma.production.findMany({ where, skip, take: Number(limit), orderBy: { date: 'desc' } }),
    prisma.production.count({ where }),
  ]);

  res.json(ApiResponse.paginated(productions, Number(page), Number(limit), total));
});

/** POST /api/stock/productions */
export const createProduction = asyncHandler(async (req: Request, res: Response) => {
  const {
    itemName, quantity, unit, notes, menuItemId, deductIngredients,
    producedIngredientId, consumedIngredients, warehouseId, shelfLifeMinutes,
  } = req.body;

  if (!itemName?.trim()) throw ApiError.badRequest('Item name is required');
  if (!quantity || Number(quantity) <= 0) throw ApiError.badRequest('Quantity must be greater than 0');

  // Optional per-batch expiry override (minutes from now). Null/blank/invalid -> fall
  // back to the produced ingredient's shelfLifeHours at read time.
  const slmRaw = Number(shelfLifeMinutes);
  const batchShelfLifeMinutes =
    Number.isFinite(slmRaw) && slmRaw >= 0 ? Math.round(slmRaw) : null;

  const prodOutletId = resolveCreateOutlet(req);

  const production = await prisma.$transaction(async (tx) => {
    const prod = await tx.production.create({
      data: {
        itemName: itemName.trim(),
        quantity: Number(quantity),
        unit: unit || null,
        producedBy: req.user?.name || null,
        date: new Date(),
        notes: notes || null,
        outletId: prodOutletId,
      },
    });

    // Path A (existing): deduct a menu item's recipe ingredients.
    if (menuItemId && deductIngredients) {
      const recipes = await tx.foodRecipe.findMany({
        where: { menuItemId },
        include: { ingredient: true },
      });
      for (const recipe of recipes) {
        const required = Number(recipe.qtyPerUnit) * Number(quantity);
        await tx.ingredient.update({
          where: { id: recipe.ingredientId },
          data: { currentStock: { increment: -required } },
        });
      }
    }

    // Path B (new): produce a short-life ingredient (dough). Consume picked ingredients,
    // add the produced stock, and create a time-stamped StockBatch (the 8-hr clock starts now).
    if (producedIngredientId) {
      let whId: string | null = warehouseId || null;
      if (!whId) {
        const kw = await tx.warehouse.findFirst({
          where: { type: 'KITCHEN' as never, isActive: true, outletId: prodOutletId },
          select: { id: true },
        });
        whId = kw?.id ?? null;
      }
      if (!whId) throw ApiError.badRequest('No kitchen warehouse found to store the produced batch');

      if (Array.isArray(consumedIngredients)) {
        for (const c of consumedIngredients) {
          if (!c?.ingredientId || !c?.qty) continue;
          await tx.ingredient.update({
            where: { id: c.ingredientId },
            data: { currentStock: { decrement: Number(c.qty) } },
          });
        }
      }

      await tx.ingredient.update({
        where: { id: producedIngredientId },
        data: { currentStock: { increment: Number(quantity) } },
      });

      await tx.stockBatch.create({
        data: {
          warehouseId: whId,
          ingredientId: producedIngredientId,
          batchQty: Number(quantity),
          remainingQty: Number(quantity),
          expiryDate: null, // exact expiry is derived from shelfLifeMinutes/shelfLifeHours, not this date column
          shelfLifeMinutes: batchShelfLifeMinutes, // per-batch override; null -> use ingredient.shelfLifeHours
        },
      });

      await tx.stockAdjustment.create({
        data: {
          ingredientId: producedIngredientId,
          type: 'produce',
          quantity: Number(quantity),
          reason: `Produced ${itemName.trim()}`,
          adjustedById: req.user?.id ?? null,
          warehouseId: whId,
          outletId: prodOutletId,
          date: new Date(),
        },
      });
    }

    return prod;
  }, { timeout: 60000 });

  res.status(201).json(ApiResponse.created(production, 'Production recorded'));
});

// ============================================================
// TRANSFERS
// ============================================================

/** GET /api/stock/transfers */
export const getTransfers = asyncHandler(async (req: Request, res: Response) => {
  const { status, page = '1', limit = '50' } = req.query;
  const skip = (Number(page) - 1) * Number(limit);

  const where: any = {};
  if (status) where.status = String(status);
  const scope = resolveOutletScope(req);
  if (scope) where.OR = [{ fromOutletId: scope }, { toOutletId: scope }];

  const [transfers, total] = await Promise.all([
    prisma.transfer.findMany({
      where,
      skip,
      take: Number(limit),
      orderBy: { date: 'desc' },
      include: {
        fromOutlet: { select: { id: true, name: true } },
        toOutlet: { select: { id: true, name: true } },
      },
    }),
    prisma.transfer.count({ where }),
  ]);

  res.json(ApiResponse.paginated(transfers, Number(page), Number(limit), total));
});

/** POST /api/stock/transfers */
export const createTransfer = asyncHandler(async (req: Request, res: Response) => {
  const { fromOutletId, toOutletId, itemName, quantity, unit, notes } = req.body;

  if (!itemName?.trim()) throw ApiError.badRequest('Item name is required');

  // Forge guard: a scoped (non-super-admin) user may only originate a transfer
  // FROM their own outlet — ignore any client-sent fromOutletId. Super Admin
  // (scope null) keeps full control over the source.
  const scope = resolveOutletScope(req);
  const safeFromOutletId = scope ?? (fromOutletId || null);

  const transfer = await prisma.transfer.create({
    data: {
      fromOutletId: safeFromOutletId,
      toOutletId: toOutletId || null,
      itemName: itemName.trim(),
      quantity: quantity ? Number(quantity) : null,
      unit: unit || null,
      transferredBy: req.user?.name || null,
      date: new Date(),
      notes: notes || null,
      status: 'pending',
    },
    include: {
      fromOutlet: { select: { id: true, name: true } },
      toOutlet: { select: { id: true, name: true } },
    },
  });

  res.status(201).json(ApiResponse.created(transfer, 'Transfer created'));
});

/** PUT /api/stock/transfers/:id */
export const updateTransferStatus = asyncHandler(async (req: Request, res: Response) => {
  const { id } = req.params;
  const { status } = req.body;

  const transfer = await prisma.transfer.findUnique({ where: { id } });
  if (!transfer) throw ApiError.notFound('Transfer not found');
  const scope = resolveOutletScope(req);
  if (scope && transfer.fromOutletId !== scope && transfer.toOutletId !== scope) {
    throw ApiError.notFound('Transfer not found');
  }

  const updated = await prisma.transfer.update({
    where: { id },
    data: { status },
    include: {
      fromOutlet: { select: { id: true, name: true } },
      toOutlet: { select: { id: true, name: true } },
    },
  });

  res.json(ApiResponse.success(updated, 'Transfer updated'));
});

// ============================================================
// WASTE RECORDS
// ============================================================

/** GET /api/stock/waste */
export const getWasteRecords = asyncHandler(async (req: Request, res: Response) => {
  const { search, page = '1', limit = '50' } = req.query;
  const skip = (Number(page) - 1) * Number(limit);

  const where: any = {};
  if (search) where.itemName = { contains: String(search), mode: 'insensitive' };
  const scope = resolveOutletScope(req);
  if (scope) where.outletId = scope;

  const [records, total] = await Promise.all([
    prisma.wasteRecord.findMany({ where, skip, take: Number(limit), orderBy: { date: 'desc' } }),
    prisma.wasteRecord.count({ where }),
  ]);

  res.json(ApiResponse.paginated(records, Number(page), Number(limit), total));
});

/** POST /api/stock/waste */
export const createWasteRecord = asyncHandler(async (req: Request, res: Response) => {
  const { itemName, quantity, unit, reason, cost, ingredientId } = req.body;

  if (!itemName?.trim()) throw ApiError.badRequest('Item name is required');
  const outletId = resolveCreateOutlet(req);

  const record = await prisma.$transaction(async (tx) => {
    const waste = await tx.wasteRecord.create({
      data: {
        itemName: itemName.trim(),
        quantity: quantity ? Number(quantity) : null,
        unit: unit || null,
        reason: reason || null,
        cost: cost ? Number(cost) : null,
        recordedBy: req.user?.name || null,
        outletId,
        date: new Date(),
      },
    });

    // Deduct from ingredient stock if ingredientId provided
    if (ingredientId) {
      const ingredient = await tx.ingredient.findUnique({ where: { id: ingredientId } });
      if (ingredient && quantity) {
        await tx.ingredient.update({
          where: { id: ingredientId },
          data: { currentStock: { increment: -Number(quantity) } },
        });
      }
    }

    return waste;
  }, { timeout: 60000 });

  res.status(201).json(ApiResponse.created(record, 'Waste record saved'));
});

// ============================================================
// DOUGH / SHORT-LIFE BATCHES
// ============================================================

/** GET /api/stock/dough-batches?outletId=<id|all> */
export const getDoughBatches = asyncHandler(async (req: Request, res: Response) => {
  const scope = resolveOutletScope(req);
  const now = new Date();

  const batches = await prisma.stockBatch.findMany({
    where: {
      remainingQty: { gt: 0 },
      // Short-life batch = the ingredient has a default shelf life OR this batch carries a per-batch override.
      OR: [
        { ingredient: { shelfLifeHours: { not: null } } },
        { shelfLifeMinutes: { not: null } },
      ],
      ...(scope ? { warehouse: { outletId: scope } } : {}),
    },
    select: {
      id: true, ingredientId: true, remainingQty: true, createdAt: true, shelfLifeMinutes: true,
      ingredient: { select: { name: true, shelfLifeHours: true, unit: { select: { name: true } } } },
    },
    orderBy: { createdAt: 'asc' },
  });

  const rows = batches.map((b) => {
    const expiresAt = effectiveExpiry(b.createdAt, b.shelfLifeMinutes, b.ingredient.shelfLifeHours);
    return {
      id: b.id,
      ingredientId: b.ingredientId,
      ingredientName: b.ingredient.name,
      unit: b.ingredient.unit?.name ?? null,
      remainingQty: Number(b.remainingQty),
      madeAt: b.createdAt.toISOString(),
      expiresAt: expiresAt.toISOString(),
      minutesRemaining: minutesRemaining(expiresAt, now),
      status: batchStatus(expiresAt, now),
    };
  });
  rows.sort((a, b) => new Date(a.expiresAt).getTime() - new Date(b.expiresAt).getTime());

  res.json(ApiResponse.success(rows));
});

/** POST /api/stock/dough-batches/:id/waste */
export const wasteDoughBatch = asyncHandler(async (req: Request, res: Response) => {
  const { id } = req.params;

  const waste = await prisma.$transaction(async (tx) => {
    const batch = await tx.stockBatch.findUnique({
      where: { id },
      select: {
        remainingQty: true, ingredientId: true,
        warehouse: { select: { outletId: true } },
        ingredient: { select: { name: true, purchasePrice: true, unit: { select: { name: true } } } },
      },
    });
    if (!batch) throw ApiError.notFound('Batch not found');
    const scope = resolveOutletScope(req);
    if (scope && batch.warehouse?.outletId !== scope) throw ApiError.notFound('Batch not found');
    const wasteOutletId = resolveCreateOutlet(req, batch.warehouse?.outletId);
    const remaining = Number(batch.remainingQty);
    if (remaining <= 0) throw ApiError.badRequest('Batch already empty');

    // Atomic zero: only the call that actually flips remainingQty>0 -> 0 proceeds.
    // Prevents a double-waste race under Read Committed (two concurrent calls).
    const zeroed = await tx.stockBatch.updateMany({
      where: { id, remainingQty: { gt: 0 } },
      data: { remainingQty: 0 },
    });
    if (zeroed.count === 0) throw ApiError.badRequest('Batch already empty');

    await tx.ingredient.update({
      where: { id: batch.ingredientId },
      data: { currentStock: { decrement: remaining } },
    });

    return tx.wasteRecord.create({
      data: {
        itemName: batch.ingredient.name,
        quantity: remaining,
        unit: batch.ingredient.unit?.name ?? null,
        cost: Number(batch.ingredient.purchasePrice ?? 0) * remaining,
        reason: 'Expired (short shelf life)',
        outletId: wasteOutletId,
        recordedBy: req.user?.name ?? null,
        date: new Date(),
      },
    });
  }, { timeout: 60000 });

  res.status(201).json(ApiResponse.created(waste, 'Batch wasted'));
});
