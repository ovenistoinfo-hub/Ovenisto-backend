/**
 * Inventory Controller
 * Handles: Ingredient Units, Ingredient Categories, Ingredients, Pre-Made Food
 */

import type { Request, Response } from 'express';
import { prisma } from '../../config/database.js';
import { ApiResponse } from '../../utils/ApiResponse.js';
import { ApiError } from '../../utils/ApiError.js';
import { asyncHandler } from '../../utils/asyncHandler.js';

// ============================================================
// INGREDIENT UNITS (with symbol & conversions)
// ============================================================

function mapConversion(c: any) {
  return { ...c, factor: Number(c.factor) };
}

const unitInclude = {
  _count: { select: { ingredients: true } },
  conversionsFrom: {
    include: { toUnit: { select: { id: true, name: true, symbol: true } } },
  },
};

function mapUnit(u: any) {
  return {
    ...u,
    conversionsFrom: u.conversionsFrom?.map(mapConversion) ?? [],
  };
}

/** GET /api/inventory/units */
export const getUnits = asyncHandler(async (_req: Request, res: Response) => {
  const units = await prisma.ingredientUnit.findMany({
    where: { status: 'active' },
    orderBy: { name: 'asc' },
    include: unitInclude,
  });
  res.json(ApiResponse.success(units.map(mapUnit)));
});

/** POST /api/inventory/units */
export const createUnit = asyncHandler(async (req: Request, res: Response) => {
  const { name, symbol, status, conversions } = req.body;
  if (!name?.trim()) throw ApiError.badRequest('Unit name is required');
  if (!symbol?.trim()) throw ApiError.badRequest('Unit symbol is required');

  const existing = await prisma.ingredientUnit.findFirst({ where: { name: { equals: name.trim(), mode: 'insensitive' } } });
  if (existing) throw ApiError.conflict('A unit with this name already exists');

  // Validate conversions
  if (conversions && Array.isArray(conversions)) {
    for (const c of conversions) {
      if (!c.toUnitId || !c.factor || Number(c.factor) <= 0) {
        throw ApiError.badRequest('Each conversion must have a valid toUnitId and positive factor');
      }
    }
  }

  const unit = await prisma.$transaction(async (tx) => {
    const u = await tx.ingredientUnit.create({
      data: { name: name.trim(), symbol: symbol.trim(), status: status ?? 'active' },
    });

    // Create bidirectional conversions
    if (conversions && Array.isArray(conversions)) {
      for (const c of conversions) {
        await tx.unitConversion.create({
          data: { fromUnitId: u.id, toUnitId: c.toUnitId, factor: Number(c.factor) },
        });
        await tx.unitConversion.upsert({
          where: { fromUnitId_toUnitId: { fromUnitId: c.toUnitId, toUnitId: u.id } },
          create: { fromUnitId: c.toUnitId, toUnitId: u.id, factor: 1 / Number(c.factor) },
          update: { factor: 1 / Number(c.factor) },
        });
      }
    }

    return tx.ingredientUnit.findUnique({ where: { id: u.id }, include: unitInclude });
  });

  res.status(201).json(ApiResponse.created(mapUnit(unit), 'Unit created'));
});

/** PUT /api/inventory/units/:id */
export const updateUnit = asyncHandler(async (req: Request, res: Response) => {
  const { id } = req.params;
  const { name, symbol, status, conversions } = req.body;

  const existing = await prisma.ingredientUnit.findUnique({ where: { id } });
  if (!existing) throw ApiError.notFound('Unit not found');

  if (name && name.trim() !== existing.name) {
    const nameTaken = await prisma.ingredientUnit.findFirst({ where: { name: { equals: name.trim(), mode: 'insensitive' }, NOT: { id } } });
    if (nameTaken) throw ApiError.conflict('A unit with this name already exists');
  }

  // Validate conversions
  if (conversions && Array.isArray(conversions)) {
    for (const c of conversions) {
      if (!c.toUnitId || !c.factor || Number(c.factor) <= 0) {
        throw ApiError.badRequest('Each conversion must have a valid toUnitId and positive factor');
      }
    }
  }

  const unit = await prisma.$transaction(async (tx) => {
    await tx.ingredientUnit.update({
      where: { id },
      data: {
        ...(name && { name: name.trim() }),
        ...(symbol !== undefined && { symbol: symbol?.trim() ?? '' }),
        ...(status && { status }),
      },
    });

    // Rebuild conversions if provided
    if (conversions !== undefined && Array.isArray(conversions)) {
      // Delete all existing conversions involving this unit
      await tx.unitConversion.deleteMany({ where: { OR: [{ fromUnitId: id }, { toUnitId: id }] } });

      // Recreate bidirectional conversions
      for (const c of conversions) {
        await tx.unitConversion.create({
          data: { fromUnitId: id, toUnitId: c.toUnitId, factor: Number(c.factor) },
        });
        await tx.unitConversion.upsert({
          where: { fromUnitId_toUnitId: { fromUnitId: c.toUnitId, toUnitId: id } },
          create: { fromUnitId: c.toUnitId, toUnitId: id, factor: 1 / Number(c.factor) },
          update: { factor: 1 / Number(c.factor) },
        });
      }
    }

    return tx.ingredientUnit.findUnique({ where: { id }, include: unitInclude });
  });

  res.json(ApiResponse.success(mapUnit(unit), 'Unit updated'));
});

/** DELETE /api/inventory/units/:id */
export const deleteUnit = asyncHandler(async (req: Request, res: Response) => {
  const existing = await prisma.ingredientUnit.findUnique({ where: { id: req.params.id }, include: { _count: { select: { ingredients: true } } } });
  if (!existing) throw ApiError.notFound('Unit not found');
  if (existing._count.ingredients > 0) throw ApiError.badRequest(`Cannot delete: ${existing._count.ingredients} ingredient(s) use this unit`);

  // onDelete: Cascade will clean up UnitConversion records automatically
  await prisma.ingredientUnit.delete({ where: { id: req.params.id } });
  res.json(ApiResponse.success(null, 'Unit deleted'));
});

// ============================================================
// INGREDIENT CATEGORIES
// ============================================================

/** GET /api/inventory/ingredient-categories */
export const getIngredientCategories = asyncHandler(async (_req: Request, res: Response) => {
  const categories = await prisma.ingredientCategory.findMany({
    orderBy: { name: 'asc' },
    include: { _count: { select: { ingredients: true } } },
  });
  res.json(ApiResponse.success(categories));
});

/** POST /api/inventory/ingredient-categories */
export const createIngredientCategory = asyncHandler(async (req: Request, res: Response) => {
  const { name, description, status } = req.body;
  if (!name?.trim()) throw ApiError.badRequest('Category name is required');

  const existing = await prisma.ingredientCategory.findFirst({ where: { name: { equals: name.trim(), mode: 'insensitive' } } });
  if (existing) throw ApiError.conflict('A category with this name already exists');

  const category = await prisma.ingredientCategory.create({
    data: { name: name.trim(), description: description || null, status: status ?? 'active' },
    include: { _count: { select: { ingredients: true } } },
  });
  res.status(201).json(ApiResponse.created(category, 'Ingredient category created'));
});

/** PUT /api/inventory/ingredient-categories/:id */
export const updateIngredientCategory = asyncHandler(async (req: Request, res: Response) => {
  const { id } = req.params;
  const { name, description, status } = req.body;

  const existing = await prisma.ingredientCategory.findUnique({ where: { id } });
  if (!existing) throw ApiError.notFound('Category not found');

  if (name && name.trim() !== existing.name) {
    const nameTaken = await prisma.ingredientCategory.findFirst({ where: { name: { equals: name.trim(), mode: 'insensitive' }, NOT: { id } } });
    if (nameTaken) throw ApiError.conflict('A category with this name already exists');
  }

  const category = await prisma.ingredientCategory.update({
    where: { id },
    data: { ...(name && { name: name.trim() }), ...(description !== undefined && { description: description || null }), ...(status && { status }) },
    include: { _count: { select: { ingredients: true } } },
  });
  res.json(ApiResponse.success(category, 'Category updated'));
});

/** DELETE /api/inventory/ingredient-categories/:id */
export const deleteIngredientCategory = asyncHandler(async (req: Request, res: Response) => {
  const existing = await prisma.ingredientCategory.findUnique({ where: { id: req.params.id }, include: { _count: { select: { ingredients: true } } } });
  if (!existing) throw ApiError.notFound('Category not found');
  if (existing._count.ingredients > 0) throw ApiError.badRequest(`Cannot delete: ${existing._count.ingredients} ingredient(s) use this category`);

  await prisma.ingredientCategory.delete({ where: { id: req.params.id } });
  res.json(ApiResponse.success(null, 'Category deleted'));
});

// ============================================================
// INGREDIENTS
// ============================================================

/** GET /api/inventory/ingredients */
export const getIngredients = asyncHandler(async (req: Request, res: Response) => {
  const { search, categoryId, status, lowStock } = req.query;

  const where: any = {};
  if (search) where.name = { contains: String(search), mode: 'insensitive' };
  if (categoryId) where.categoryId = String(categoryId);
  if (status) where.status = String(status);
  if (lowStock === 'true') where.AND = [{ currentStock: { lte: prisma.ingredient.fields.lowStockLevel } }];

  const ingredients = await prisma.ingredient.findMany({
    where,
    orderBy: [{ category: { name: 'asc' } }, { name: 'asc' }],
    include: {
      category: { select: { id: true, name: true } },
      unit: { select: { id: true, name: true } },
    },
  });

  // Filter low stock in JS since Prisma doesn't support column comparison in where
  const result = lowStock === 'true'
    ? ingredients.filter(i => Number(i.currentStock) <= Number(i.lowStockLevel))
    : ingredients;

  res.json(ApiResponse.success(result));
});

/** GET /api/inventory/ingredients/:id */
export const getIngredient = asyncHandler(async (req: Request, res: Response) => {
  const ingredient = await prisma.ingredient.findUnique({
    where: { id: req.params.id },
    include: {
      category: { select: { id: true, name: true } },
      unit: { select: { id: true, name: true } },
    },
  });
  if (!ingredient) throw ApiError.notFound('Ingredient not found');
  res.json(ApiResponse.success(ingredient));
});

/** POST /api/inventory/ingredients */
export const createIngredient = asyncHandler(async (req: Request, res: Response) => {
  const { name, categoryId, unitId, purchasePrice, currentStock, lowStockLevel, status } = req.body;
  if (!name?.trim()) throw ApiError.badRequest('Ingredient name is required');

  const ingredient = await prisma.ingredient.create({
    data: {
      name: name.trim(),
      categoryId: categoryId || null,
      unitId: unitId || null,
      purchasePrice: purchasePrice ?? null,
      currentStock: currentStock ?? 0,
      lowStockLevel: lowStockLevel ?? 0,
      status: status ?? 'active',
    },
    include: {
      category: { select: { id: true, name: true } },
      unit: { select: { id: true, name: true } },
    },
  });
  res.status(201).json(ApiResponse.created(ingredient, 'Ingredient created'));
});

/** PUT /api/inventory/ingredients/:id */
export const updateIngredient = asyncHandler(async (req: Request, res: Response) => {
  const { id } = req.params;
  const { name, categoryId, unitId, purchasePrice, currentStock, lowStockLevel, status } = req.body;

  const existing = await prisma.ingredient.findUnique({ where: { id } });
  if (!existing) throw ApiError.notFound('Ingredient not found');

  const ingredient = await prisma.ingredient.update({
    where: { id },
    data: {
      ...(name && { name: name.trim() }),
      ...(categoryId !== undefined && { categoryId: categoryId || null }),
      ...(unitId !== undefined && { unitId: unitId || null }),
      ...(purchasePrice !== undefined && { purchasePrice: purchasePrice ?? null }),
      ...(currentStock !== undefined && { currentStock }),
      ...(lowStockLevel !== undefined && { lowStockLevel }),
      ...(status && { status }),
    },
    include: {
      category: { select: { id: true, name: true } },
      unit: { select: { id: true, name: true } },
    },
  });

  // Propagate lowStockLevel change to all WarehouseStock records
  if (lowStockLevel !== undefined) {
    await prisma.warehouseStock.updateMany({
      where: { ingredientId: id },
      data: { lowStockLevel },
    });
  }

  res.json(ApiResponse.success(ingredient, 'Ingredient updated'));
});

/** DELETE /api/inventory/ingredients/:id */
export const deleteIngredient = asyncHandler(async (req: Request, res: Response) => {
  const existing = await prisma.ingredient.findUnique({ where: { id: req.params.id } });
  if (!existing) throw ApiError.notFound('Ingredient not found');
  // Soft delete
  await prisma.ingredient.update({ where: { id: req.params.id }, data: { status: 'inactive' } });
  res.json(ApiResponse.success(null, 'Ingredient deactivated'));
});

// ============================================================
// PRE-MADE FOOD
// ============================================================

/** GET /api/inventory/pre-made */
export const getPreMadeFood = asyncHandler(async (_req: Request, res: Response) => {
  const items = await prisma.preMadeFood.findMany({ orderBy: { name: 'asc' } });
  res.json(ApiResponse.success(items));
});

/** POST /api/inventory/pre-made */
export const createPreMadeFood = asyncHandler(async (req: Request, res: Response) => {
  const { name, unit, currentStock, lowStockLevel, costPerUnit, status } = req.body;
  if (!name?.trim()) throw ApiError.badRequest('Name is required');

  const item = await prisma.preMadeFood.create({
    data: {
      name: name.trim(),
      unit: unit || null,
      currentStock: currentStock ?? 0,
      lowStockLevel: lowStockLevel ?? 0,
      costPerUnit: costPerUnit ?? null,
      status: status ?? 'active',
    },
  });
  res.status(201).json(ApiResponse.created(item, 'Pre-made food item created'));
});

/** PUT /api/inventory/pre-made/:id */
export const updatePreMadeFood = asyncHandler(async (req: Request, res: Response) => {
  const { id } = req.params;
  const { name, unit, currentStock, lowStockLevel, costPerUnit, status } = req.body;

  const existing = await prisma.preMadeFood.findUnique({ where: { id } });
  if (!existing) throw ApiError.notFound('Pre-made food item not found');

  const item = await prisma.preMadeFood.update({
    where: { id },
    data: {
      ...(name && { name: name.trim() }),
      ...(unit !== undefined && { unit: unit || null }),
      ...(currentStock !== undefined && { currentStock }),
      ...(lowStockLevel !== undefined && { lowStockLevel }),
      ...(costPerUnit !== undefined && { costPerUnit: costPerUnit ?? null }),
      ...(status && { status }),
    },
  });
  res.json(ApiResponse.success(item, 'Pre-made food item updated'));
});

/** DELETE /api/inventory/pre-made/:id */
export const deletePreMadeFood = asyncHandler(async (req: Request, res: Response) => {
  const existing = await prisma.preMadeFood.findUnique({ where: { id: req.params.id } });
  if (!existing) throw ApiError.notFound('Pre-made food item not found');
  await prisma.preMadeFood.delete({ where: { id: req.params.id } });
  res.json(ApiResponse.success(null, 'Pre-made food item deleted'));
});
