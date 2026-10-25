/** Shared by self-order and website.
 *  Public-safe shape (no channel price fields, no stock numbers). */
import { resolveChannelPrice } from '../deals/deal.pricing.js';
import type { PrismaClient } from '@prisma/client';

export const parsePrices = (obj: any) => ({
  ...obj,
  price: Number(obj.price),
  dineInPrice: obj.dineInPrice != null ? Number(obj.dineInPrice) : null,
  takeAwayPrice: obj.takeAwayPrice != null ? Number(obj.takeAwayPrice) : null,
  deliveryPrice: obj.deliveryPrice != null ? Number(obj.deliveryPrice) : null,
  foodpandaPrice: obj.foodpandaPrice != null ? Number(obj.foodpandaPrice) : null,
});

/** Whether at least one complete unit of `menuItemId` (at this `variantId`,
 *  or the item's own base recipe when `variantId` is null) can currently be
 *  made from the given stock maps — the same "floor(stock / qtyPerUnit),
 *  minimum across every ingredient/production item" rule as the frontend's
 *  calculateFoodAvailability and this file's own validateOrderStock, reduced
 *  to a boolean since a public, unauthenticated route has no business
 *  returning raw stock numbers to a customer's phone. An item with no
 *  recipe rows at all is always available — no recipe configured means
 *  nothing here restricts it. */
export function isVariantAvailable(
  recipes: { variantId: string | null; ingredientId: string | null; productionItemId: string | null; qtyPerUnit: unknown }[],
  variantId: string | null,
  ingredientStock: Map<string, number>,
  productionStock: Map<string, number>,
): boolean {
  const relevant = recipes.filter((r) => (variantId ? !r.variantId || r.variantId === variantId : !r.variantId));
  if (relevant.length === 0) return true;
  for (const r of relevant) {
    const qtyPerUnit = Number(r.qtyPerUnit);
    if (!qtyPerUnit || qtyPerUnit <= 0) continue;
    const stock = r.ingredientId
      ? ingredientStock.get(r.ingredientId) ?? 0
      : r.productionItemId
      ? productionStock.get(r.productionItemId) ?? 0
      : 0;
    if (Math.floor(stock / qtyPerUnit) <= 0) return false;
  }
  return true;
}

export function toPublicMenuItem(
  item: any,
  itemRecipes: any[],
  ingredientStock: Map<string, number>,
  productionStock: Map<string, number>,
  orderType?: string,
) {
  const variants = item.variants.map((v: any) => ({
    id: v.id,
    name: v.name,
    price: orderType ? resolveChannelPrice(parsePrices(v), orderType) : Number(v.price),
    available: isVariantAvailable(itemRecipes, v.id, ingredientStock, productionStock),
  }));

  const available = variants.length > 0
    ? variants.some((v: any) => v.available)
    : isVariantAvailable(itemRecipes, null, ingredientStock, productionStock);

  return {
    id: item.id,
    name: item.name,
    price: orderType ? resolveChannelPrice(parsePrices(item), orderType) : Number(item.price),
    image: item.image ?? null,
    category: item.category ? { id: item.category.id, name: item.category.name } : null,
    mealTypeIds: item.mealTypeIds ?? [],
    isNew: item.isNew === true,
    advanceHours: item.advanceHours ?? null,
    available,
    variants,
    modifiers: item.modifiers
      .filter((mm: any) => mm.modifier.status === 'active')
      .map((mm: any) => ({ id: mm.modifier.id, name: mm.modifier.name, price: Number(mm.modifier.price) })),
  };
}

export async function buildPublicMenu(prisma: PrismaClient, options: { outletId: string | null; orderType?: string }) {
  const { outletId, orderType } = options;

  // Independent reads run together: this is a public page load, and each DB round trip adds up.
  const [categories, items, recipes, kitchenWarehouseId] = await Promise.all([
    prisma.foodCategory.findMany({
      where: { status: 'active' },
      orderBy: [{ displayOrder: 'asc' }, { name: 'asc' }],
      select: { id: true, name: true, displayOrder: true, status: true },
    }),
    prisma.foodMenuItem.findMany({
      where: { available: true },
      orderBy: [{ category: { displayOrder: 'asc' } }, { name: 'asc' }],
      include: {
        category: { select: { id: true, name: true } },
        variants: { orderBy: { displayOrder: 'asc' } },
        modifiers: { include: { modifier: true } },
      },
    }),
    prisma.foodRecipe.findMany({
      where: { menuItem: { available: true } },
      select: { menuItemId: true, variantId: true, ingredientId: true, productionItemId: true, qtyPerUnit: true },
    }),
    findKitchenWarehouseId(prisma, outletId),
  ]);

  const { ingredientStock, productionStock } = await loadKitchenStock(prisma, outletId, recipes, kitchenWarehouseId);

  const recipesByItem = new Map<string, typeof recipes>();
  for (const r of recipes) {
    if (!recipesByItem.has(r.menuItemId)) recipesByItem.set(r.menuItemId, []);
    recipesByItem.get(r.menuItemId)!.push(r);
  }

  const publicItems = items.map((item: any) => {
    const itemRecipes = recipesByItem.get(item.id) ?? [];
    return toPublicMenuItem(item, itemRecipes, ingredientStock, productionStock, orderType);
  });

  return { categories, items: publicItems };
}

type RecipeRow = { menuItemId: string; variantId: string | null; ingredientId: string | null; productionItemId: string | null; qtyPerUnit: unknown };

async function findKitchenWarehouseId(prisma: PrismaClient, outletId: string | null): Promise<string | null> {
  if (!outletId) return null;
  const kw = await prisma.warehouse.findFirst({
    where: { outletId, type: 'KITCHEN' as never, isActive: true },
    select: { id: true },
  });
  return kw?.id ?? null;
}

/**
 * The outlet's kitchen stock for the ingredients and production items these recipes use.
 * `knownWarehouseId`: the kitchen warehouse when the caller already looked it up (undefined = look it up here).
 */
export async function loadKitchenStock(prisma: PrismaClient, outletId: string | null, recipes: RecipeRow[], knownWarehouseId?: string | null) {
  const ingredientStock = new Map<string, number>();
  const productionStock = new Map<string, number>();
  if (recipes.length > 0) {
    const kitchenWarehouseId = knownWarehouseId !== undefined ? knownWarehouseId : await findKitchenWarehouseId(prisma, outletId);
    const ingredientIds = Array.from(new Set(recipes.map((r: any) => r.ingredientId).filter((id: any): id is string => !!id)));
    const productionItemIds = Array.from(new Set(recipes.map((r: any) => r.productionItemId).filter((id: any): id is string => !!id)));

    if (kitchenWarehouseId) {
      const [ingredientRows, productionRows] = await Promise.all([
        ingredientIds.length
          ? prisma.warehouseStock.findMany({
              where: { warehouseId: kitchenWarehouseId, ingredientId: { in: ingredientIds } },
              select: { ingredientId: true, currentStock: true },
            })
          : [],
        productionItemIds.length
          ? prisma.productionWarehouseStock.findMany({
              where: { warehouseId: kitchenWarehouseId, productionItemId: { in: productionItemIds } },
              select: { productionItemId: true, currentStock: true },
            })
          : [],
      ]);
      for (const r of ingredientRows) ingredientStock.set(r.ingredientId, Math.max(0, Number(r.currentStock)));
      for (const r of productionRows) {
        productionStock.set(r.productionItemId, (productionStock.get(r.productionItemId) ?? 0) + Math.max(0, Number(r.currentStock)));
      }
    } else if (ingredientIds.length) {
      // No kitchen warehouse for this outlet — fall back to the chain-wide
      // Ingredient record, same fallback validateOrderStock uses.
      const rows = await prisma.ingredient.findMany({
        where: { id: { in: ingredientIds } },
        select: { id: true, currentStock: true },
      });
      for (const r of rows) ingredientStock.set(r.id, Math.max(0, Number(r.currentStock)));
    }
  }
  return { ingredientStock, productionStock };
}

/**
 * The name of the first ordered dish (or size) the outlet's kitchen can't make even one of right now,
 * by the same rule as the menu's `available` flag; null when every dish can be made.
 */
export async function findSoldOutItem(
  prisma: PrismaClient,
  outletId: string | null,
  items: { menuItemId?: string | null; variantId?: string | null }[],
): Promise<string | null> {
  const ids = [...new Set(items.map((i) => i.menuItemId).filter((id): id is string => !!id))];
  if (ids.length === 0) return null;
  const recipes = await prisma.foodRecipe.findMany({
    where: { menuItemId: { in: ids } },
    select: { menuItemId: true, variantId: true, ingredientId: true, productionItemId: true, qtyPerUnit: true },
  });
  if (recipes.length === 0) return null;
  const { ingredientStock, productionStock } = await loadKitchenStock(prisma, outletId, recipes);
  const soldOut = items.find((i) => i.menuItemId
    && !isVariantAvailable(recipes.filter((r) => r.menuItemId === i.menuItemId), i.variantId ?? null, ingredientStock, productionStock));
  if (!soldOut) return null;
  const dish = await prisma.foodMenuItem.findUnique({ where: { id: soldOut.menuItemId! }, select: { name: true } });
  return dish?.name ?? 'An item';
}
