/**
 * Stock Controller
 * Phase 4: Stock Adjustments, Stock Takes, Production, Transfers, Waste Records
 */

import type { Request, Response } from 'express';
import { prisma } from '../../config/database.js';
import { ApiResponse } from '../../utils/ApiResponse.js';
import { ApiError } from '../../utils/ApiError.js';
import { asyncHandler } from '../../utils/asyncHandler.js';

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

  // Outlet scoping: non-Super Admin sees only their outlet's warehouse adjustments
  if (req.user?.role !== 'Super Admin') {
    if (req.user?.outletId) {
      where.warehouse = {
        OR: [{ outletId: req.user.outletId }, { type: 'MAIN' }],
      };
    }
  }

  const [adjustments, total] = await Promise.all([
    prisma.stockAdjustment.findMany({
      where,
      skip,
      take: Number(limit),
      orderBy: { date: 'desc' },
      include: {
        ingredient: { select: { id: true, name: true, unit: { select: { name: true } } } },
        adjustedBy: { select: { id: true, name: true } },
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
        date: new Date(),
      },
      include: {
        ingredient: { select: { id: true, name: true, unit: { select: { name: true } } } },
        adjustedBy: { select: { id: true, name: true } },
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
  });

  res.status(201).json(ApiResponse.created(adjustment, 'Stock adjustment recorded'));
});

// ============================================================
// STOCK TAKES
// ============================================================

/** GET /api/stock/takes */
export const getStockTakes = asyncHandler(async (_req: Request, res: Response) => {
  const takes = await prisma.stockTake.findMany({
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
  res.json(ApiResponse.success(take));
});

/** POST /api/stock/takes - start a new stock take (captures system quantities) */
export const startStockTake = asyncHandler(async (req: Request, res: Response) => {
  const { notes } = req.body;

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
  });

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

  const [productions, total] = await Promise.all([
    prisma.production.findMany({ where, skip, take: Number(limit), orderBy: { date: 'desc' } }),
    prisma.production.count({ where }),
  ]);

  res.json(ApiResponse.paginated(productions, Number(page), Number(limit), total));
});

/** POST /api/stock/productions */
export const createProduction = asyncHandler(async (req: Request, res: Response) => {
  const { itemName, quantity, unit, notes, menuItemId, deductIngredients } = req.body;

  if (!itemName?.trim()) throw ApiError.badRequest('Item name is required');
  if (!quantity || Number(quantity) <= 0) throw ApiError.badRequest('Quantity must be greater than 0');

  const production = await prisma.$transaction(async (tx) => {
    const prod = await tx.production.create({
      data: {
        itemName: itemName.trim(),
        quantity: Number(quantity),
        unit: unit || null,
        producedBy: req.user?.name || null,
        date: new Date(),
        notes: notes || null,
      },
    });

    // If menuItemId provided and deductIngredients=true, deduct recipe ingredients
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

    return prod;
  });

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

  const transfer = await prisma.transfer.create({
    data: {
      fromOutletId: fromOutletId || null,
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

  const record = await prisma.$transaction(async (tx) => {
    const waste = await tx.wasteRecord.create({
      data: {
        itemName: itemName.trim(),
        quantity: quantity ? Number(quantity) : null,
        unit: unit || null,
        reason: reason || null,
        cost: cost ? Number(cost) : null,
        recordedBy: req.user?.name || null,
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
  });

  res.status(201).json(ApiResponse.created(record, 'Waste record saved'));
});
