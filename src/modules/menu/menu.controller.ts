/**
 * Menu Controller
 * Handles: Food Categories, Food Menu Items (with variants), Modifiers, Recipes
 */

import type { Request, Response } from 'express';
import { prisma } from '../../config/database.js';
import { ApiResponse } from '../../utils/ApiResponse.js';
import { ApiError } from '../../utils/ApiError.js';
import { asyncHandler } from '../../utils/asyncHandler.js';

// ── Helpers ──

/** Normalize a menu item — convert Prisma Decimal fields to numbers */
function normalizeMenuItem(item: any): any {
  return {
    ...item,
    price:          Number(item.price),
    dineInPrice:    item.dineInPrice    != null ? Number(item.dineInPrice)    : null,
    takeAwayPrice:  item.takeAwayPrice  != null ? Number(item.takeAwayPrice)  : null,
    deliveryPrice:  item.deliveryPrice  != null ? Number(item.deliveryPrice)  : null,
    foodpandaPrice: item.foodpandaPrice != null ? Number(item.foodpandaPrice) : null,
    mealTypeIds: item.mealTypeIds ?? [],
    variants: (item.variants ?? []).map((v: any) => ({
      ...v,
      price:          Number(v.price),
      dineInPrice:    v.dineInPrice    != null ? Number(v.dineInPrice)    : null,
      takeAwayPrice:  v.takeAwayPrice  != null ? Number(v.takeAwayPrice)  : null,
      deliveryPrice:  v.deliveryPrice  != null ? Number(v.deliveryPrice)  : null,
      foodpandaPrice: v.foodpandaPrice != null ? Number(v.foodpandaPrice) : null,
    })),
    modifiers: (item.modifiers ?? []).map((m: any) => ({
      id:         m.modifier?.id     ?? m.id,
      name:       m.modifier?.name   ?? m.name,
      price:      Number(m.modifier?.price ?? m.price ?? 0),
      type:       m.modifier?.type   ?? m.type,
      status:     m.modifier?.status ?? m.status,
      variantIds: m.variantIds ?? [],
    })),
  };
}

/** Auto-generate item code from name: "Chicken Tikka" → "CT", "Pizza" → "PIZ" */
function buildCodePrefix(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length >= 2) {
    return words.map(w => w[0].toUpperCase()).join('').slice(0, 4);
  }
  return words[0].slice(0, 3).toUpperCase();
}

async function generateUniqueCode(name: string): Promise<string> {
  const prefix = buildCodePrefix(name);
  let n = 1;
  while (n <= 999) {
    const candidate = `${prefix}-${String(n).padStart(3, '0')}`;
    const exists = await prisma.foodMenuItem.findUnique({ where: { code: candidate } });
    if (!exists) return candidate;
    n++;
  }
  // Fallback: prefix + timestamp
  return `${prefix}-${Date.now().toString().slice(-4)}`;
}

// ============================================================
// FOOD CATEGORIES
// ============================================================

/** GET /api/menu/categories */
export const getCategories = asyncHandler(async (req: Request, res: Response) => {
  const { status } = req.query;
  const categories = await prisma.foodCategory.findMany({
    where: status ? { status: String(status) } : undefined,
    orderBy: [{ displayOrder: 'asc' }, { name: 'asc' }],
    include: { _count: { select: { menuItems: true } } },
  });
  res.json(ApiResponse.success(categories));
});

/** POST /api/menu/categories */
export const createCategory = asyncHandler(async (req: Request, res: Response) => {
  const { name, displayOrder, status } = req.body;
  if (!name?.trim()) throw ApiError.badRequest('Category name is required');

  const existing = await prisma.foodCategory.findFirst({ where: { name: { equals: name.trim(), mode: 'insensitive' } } });
  if (existing) throw ApiError.conflict('A category with this name already exists');

  const category = await prisma.foodCategory.create({
    data: { name: name.trim(), displayOrder: displayOrder ?? 0, status: status ?? 'active' },
    include: { _count: { select: { menuItems: true } } },
  });
  res.status(201).json(ApiResponse.created(category, 'Category created'));
});

/** PUT /api/menu/categories/:id */
export const updateCategory = asyncHandler(async (req: Request, res: Response) => {
  const { id } = req.params;
  const { name, displayOrder, status } = req.body;

  const existing = await prisma.foodCategory.findUnique({ where: { id } });
  if (!existing) throw ApiError.notFound('Category not found');

  if (name && name.trim() !== existing.name) {
    const nameTaken = await prisma.foodCategory.findFirst({ where: { name: { equals: name.trim(), mode: 'insensitive' }, NOT: { id } } });
    if (nameTaken) throw ApiError.conflict('A category with this name already exists');
  }

  const category = await prisma.foodCategory.update({
    where: { id },
    data: { ...(name && { name: name.trim() }), ...(displayOrder !== undefined && { displayOrder }), ...(status && { status }) },
    include: { _count: { select: { menuItems: true } } },
  });
  res.json(ApiResponse.success(category, 'Category updated'));
});

/** DELETE /api/menu/categories/:id */
export const deleteCategory = asyncHandler(async (req: Request, res: Response) => {
  const { id } = req.params;
  const existing = await prisma.foodCategory.findUnique({ where: { id }, include: { _count: { select: { menuItems: true } } } });
  if (!existing) throw ApiError.notFound('Category not found');
  if (existing._count.menuItems > 0) throw ApiError.badRequest(`Cannot delete: ${existing._count.menuItems} menu item(s) use this category`);

  await prisma.foodCategory.delete({ where: { id } });
  res.json(ApiResponse.success(null, 'Category deleted'));
});

// ============================================================
// FOOD MENU ITEMS
// ============================================================

/** GET /api/menu/items */
export const getMenuItems = asyncHandler(async (req: Request, res: Response) => {
  const { search, category, available, page = '1', limit = '100' } = req.query;
  const skip = (Number(page) - 1) * Number(limit);

  const where: any = {};
  if (search) where.name = { contains: String(search), mode: 'insensitive' };
  if (category) where.categoryId = String(category);
  if (available !== undefined) where.available = available === 'true';

  const [items, total] = await Promise.all([
    prisma.foodMenuItem.findMany({
      where,
      skip,
      take: Number(limit),
      orderBy: [{ category: { displayOrder: 'asc' } }, { name: 'asc' }],
      include: {
        category: { select: { id: true, name: true } },
        variants: { orderBy: { displayOrder: 'asc' } },
        modifiers: { include: { modifier: true } },
      },
    }),
    prisma.foodMenuItem.count({ where }),
  ]);

  res.json(ApiResponse.paginated(items.map(normalizeMenuItem), Number(page), Number(limit), total));
});

/** GET /api/menu/items/:id */
export const getMenuItem = asyncHandler(async (req: Request, res: Response) => {
  const item = await prisma.foodMenuItem.findUnique({
    where: { id: req.params.id },
    include: {
      category: { select: { id: true, name: true } },
      variants: { orderBy: { displayOrder: 'asc' } },
      recipes: { include: { ingredient: { include: { unit: true } }, usageUnit: { select: { id: true, name: true } } } },
      modifiers: { include: { modifier: true } },
    },
  });
  if (!item) throw ApiError.notFound('Menu item not found');
  res.json(ApiResponse.success(normalizeMenuItem(item)));
});

/** POST /api/menu/items */
export const createMenuItem = asyncHandler(async (req: Request, res: Response) => {
  const {
    name, code, categoryId, price, dineInPrice, takeAwayPrice, deliveryPrice, foodpandaPrice,
    available, image, tags, cookingTime, mealTypeIds, variants, modifierIds, modifiers: modifiersInput,
  } = req.body;

  if (!name?.trim()) throw ApiError.badRequest('Item name is required');
  if (price === undefined || price === null) throw ApiError.badRequest('Price is required');

  // Auto-generate code if not provided; validate uniqueness if provided
  let finalCode: string | null = null;
  if (code?.trim()) {
    const codeTaken = await prisma.foodMenuItem.findUnique({ where: { code: code.trim() } });
    if (codeTaken) throw ApiError.conflict('An item with this code already exists');
    finalCode = code.trim();
  } else {
    finalCode = await generateUniqueCode(name);
  }

  // Resolve modifier data: support both legacy `modifierIds` (string[]) and new `modifiers` ([{ id, variantIds }])
  const modData = modifiersInput?.length
    ? modifiersInput.map((m: any) => ({ modifierId: m.id, variantIds: m.variantIds ?? [] }))
    : modifierIds?.length
      ? modifierIds.map((mid: string) => ({ modifierId: mid, variantIds: [] as string[] }))
      : [];

  const item = await prisma.foodMenuItem.create({
    data: {
      name: name.trim(),
      code: finalCode,
      categoryId: categoryId || null,
      price,
      dineInPrice:    dineInPrice    ?? null,
      takeAwayPrice:  takeAwayPrice  ?? null,
      deliveryPrice:  deliveryPrice  ?? null,
      foodpandaPrice: foodpandaPrice ?? null,
      available: available ?? true,
      image: image || null,
      tags: tags ?? [],
      cookingTime: cookingTime ?? 0,
      mealTypeIds: mealTypeIds ?? [],
      variants: variants?.length
        ? { create: variants.map((v: any, i: number) => ({
            name: v.name, price: v.price, displayOrder: i,
            dineInPrice: v.dineInPrice ?? null, takeAwayPrice: v.takeAwayPrice ?? null,
            deliveryPrice: v.deliveryPrice ?? null, foodpandaPrice: v.foodpandaPrice ?? null,
          })) }
        : undefined,
      modifiers: modData.length
        ? { create: modData }
        : undefined,
    },
    include: {
      category: { select: { id: true, name: true } },
      variants: { orderBy: { displayOrder: 'asc' } },
      modifiers: { include: { modifier: true } },
    },
  });
  res.status(201).json(ApiResponse.created(normalizeMenuItem(item), 'Menu item created'));
});

/** PUT /api/menu/items/:id */
export const updateMenuItem = asyncHandler(async (req: Request, res: Response) => {
  const { id } = req.params;
  const {
    name, code, categoryId, price, dineInPrice, takeAwayPrice, deliveryPrice, foodpandaPrice,
    available, image, tags, cookingTime, mealTypeIds, variants, modifierIds, modifiers: modifiersInput,
  } = req.body;

  const existing = await prisma.foodMenuItem.findUnique({ where: { id } });
  if (!existing) throw ApiError.notFound('Menu item not found');

  if (code && code !== existing.code) {
    const codeTaken = await prisma.foodMenuItem.findUnique({ where: { code } });
    if (codeTaken) throw ApiError.conflict('An item with this code already exists');
  }

  // Resolve modifier data
  const hasModInput = modifiersInput !== undefined || modifierIds !== undefined;
  const modData = modifiersInput?.length
    ? modifiersInput.map((m: any) => ({ modifierId: m.id, variantIds: m.variantIds ?? [] }))
    : modifierIds?.length
      ? modifierIds.map((mid: string) => ({ modifierId: mid, variantIds: [] as string[] }))
      : [];

  // Update item + replace variants & modifiers if provided
  const item = await prisma.$transaction(async (tx) => {
    if (variants !== undefined) {
      await tx.foodMenuVariant.deleteMany({ where: { menuItemId: id } });
    }
    if (hasModInput) {
      await tx.menuItemModifier.deleteMany({ where: { menuItemId: id } });
    }
    return tx.foodMenuItem.update({
      where: { id },
      data: {
        ...(name && { name: name.trim() }),
        ...(code !== undefined && { code: code?.trim() || null }),
        ...(categoryId !== undefined && { categoryId: categoryId || null }),
        ...(price !== undefined && { price }),
        ...(dineInPrice !== undefined && { dineInPrice: dineInPrice ?? null }),
        ...(takeAwayPrice !== undefined && { takeAwayPrice: takeAwayPrice ?? null }),
        ...(deliveryPrice !== undefined && { deliveryPrice: deliveryPrice ?? null }),
        ...(foodpandaPrice !== undefined && { foodpandaPrice: foodpandaPrice ?? null }),
        ...(available !== undefined && { available }),
        ...(image !== undefined && { image: image || null }),
        ...(tags !== undefined && { tags }),
        ...(cookingTime !== undefined && { cookingTime }),
        ...(mealTypeIds !== undefined && { mealTypeIds }),
        ...(variants !== undefined && variants.length > 0 && {
          variants: { create: variants.map((v: any, i: number) => ({
            name: v.name, price: v.price, displayOrder: i,
            dineInPrice: v.dineInPrice ?? null, takeAwayPrice: v.takeAwayPrice ?? null,
            deliveryPrice: v.deliveryPrice ?? null, foodpandaPrice: v.foodpandaPrice ?? null,
          })) },
        }),
        ...(hasModInput && modData.length > 0 && {
          modifiers: { create: modData },
        }),
      },
      include: {
        category: { select: { id: true, name: true } },
        variants: { orderBy: { displayOrder: 'asc' } },
        modifiers: { include: { modifier: true } },
      },
    });
  });

  res.json(ApiResponse.success(normalizeMenuItem(item), 'Menu item updated'));
});

/** DELETE /api/menu/items/:id */
export const deleteMenuItem = asyncHandler(async (req: Request, res: Response) => {
  const existing = await prisma.foodMenuItem.findUnique({ where: { id: req.params.id } });
  if (!existing) throw ApiError.notFound('Menu item not found');
  await prisma.foodMenuItem.delete({ where: { id: req.params.id } });
  res.json(ApiResponse.success(null, 'Menu item deleted'));
});

// ============================================================
// MODIFIERS
// ============================================================

/** GET /api/menu/modifiers */
export const getModifiers = asyncHandler(async (_req: Request, res: Response) => {
  const modifiers = await prisma.modifier.findMany({ orderBy: { name: 'asc' } });
  res.json(ApiResponse.success(modifiers));
});

/** POST /api/menu/modifiers */
export const createModifier = asyncHandler(async (req: Request, res: Response) => {
  const { name, price, type, status } = req.body;
  if (!name?.trim()) throw ApiError.badRequest('Modifier name is required');

  const modifier = await prisma.modifier.create({
    data: { name: name.trim(), price: price ?? 0, type: type || 'addon', status: status ?? 'active' },
  });
  res.status(201).json(ApiResponse.created(modifier, 'Modifier created'));
});

/** PUT /api/menu/modifiers/:id */
export const updateModifier = asyncHandler(async (req: Request, res: Response) => {
  const { id } = req.params;
  const { name, price, type, status } = req.body;

  const existing = await prisma.modifier.findUnique({ where: { id } });
  if (!existing) throw ApiError.notFound('Modifier not found');

  const modifier = await prisma.modifier.update({
    where: { id },
    data: {
      ...(name && { name: name.trim() }),
      ...(price !== undefined && { price }),
      ...(type && { type }),
      ...(status && { status }),
    },
  });
  res.json(ApiResponse.success(modifier, 'Modifier updated'));
});

/** DELETE /api/menu/modifiers/:id */
export const deleteModifier = asyncHandler(async (req: Request, res: Response) => {
  const existing = await prisma.modifier.findUnique({ where: { id: req.params.id } });
  if (!existing) throw ApiError.notFound('Modifier not found');
  await prisma.modifier.delete({ where: { id: req.params.id } });
  res.json(ApiResponse.success(null, 'Modifier deleted'));
});

// ============================================================
// RECIPES (per menu item)
// ============================================================

/** GET /api/menu/items/:id/recipe */
export const getRecipe = asyncHandler(async (req: Request, res: Response) => {
  const { id } = req.params;
  const item = await prisma.foodMenuItem.findUnique({ where: { id }, select: { id: true, name: true } });
  if (!item) throw ApiError.notFound('Menu item not found');

  const recipes = await prisma.foodRecipe.findMany({
    where: { menuItemId: id },
    include: {
      ingredient: { include: { unit: { select: { id: true, name: true } }, category: { select: { id: true, name: true } } } },
      usageUnit: { select: { id: true, name: true } },
    },
  });
  res.json(ApiResponse.success(recipes));
});

/** PUT /api/menu/items/:id/recipe (replace all) */
export const updateRecipe = asyncHandler(async (req: Request, res: Response) => {
  const { id } = req.params;
  const { ingredients } = req.body; // [{ ingredientId, qtyPerUnit, variantId?, usageUnitId? }]

  const item = await prisma.foodMenuItem.findUnique({ where: { id }, select: { id: true } });
  if (!item) throw ApiError.notFound('Menu item not found');

  await prisma.$transaction(async (tx) => {
    await tx.foodRecipe.deleteMany({ where: { menuItemId: id } });
    if (ingredients?.length) {
      await tx.foodRecipe.createMany({
        data: ingredients.map((r: any) => ({
          menuItemId: id,
          ingredientId: r.ingredientId,
          qtyPerUnit: r.qtyPerUnit,
          variantId: r.variantId || null,
          usageUnitId: r.usageUnitId || null,
        })),
      });
    }
  });

  const recipes = await prisma.foodRecipe.findMany({
    where: { menuItemId: id },
    include: {
      ingredient: { include: { unit: { select: { id: true, name: true } } } },
      usageUnit: { select: { id: true, name: true } },
    },
  });
  res.json(ApiResponse.success(recipes, 'Recipe updated'));
});
