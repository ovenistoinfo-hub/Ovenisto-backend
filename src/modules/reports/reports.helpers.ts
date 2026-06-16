import { ApiError } from '../../utils/ApiError.js';

export interface DateRange {
  gte: Date;
  lte: Date;
}

/** Parse inclusive from/to (YYYY-MM-DD) into UTC day boundaries. Throws ApiError on invalid input. */
export function parseDateRange(from: string | undefined, to: string | undefined): DateRange {
  if (!from || !to) {
    throw ApiError.badRequest('from and to are required (YYYY-MM-DD)');
  }
  const gte = new Date(`${from}T00:00:00.000Z`);
  const lte = new Date(`${to}T23:59:59.999Z`);
  if (isNaN(gte.getTime()) || isNaN(lte.getTime())) {
    throw ApiError.badRequest('from and to must be valid dates (YYYY-MM-DD)');
  }
  return { gte, lte };
}

/** Build a Prisma `where` for orders: date range, plus outletId only when a specific outlet is chosen. */
export function buildOrderWhere(gte: Date, lte: Date, outletId: string | undefined) {
  const where: { createdAt: { gte: Date; lte: Date }; outletId?: string } = {
    createdAt: { gte, lte },
  };
  if (outletId && outletId !== 'all') {
    where.outletId = outletId;
  }
  return where;
}

export interface CogsItem {
  menuItemId: string | null;
  variantId: string | null;
  qty: number;
}
export interface CogsRecipe {
  menuItemId: string;
  variantId: string | null;
  ingredientId: string;
  qtyPerUnit: number;
}

/**
 * COGS = sum over order items of (matching recipe qtyPerUnit * item.qty * ingredient.purchasePrice).
 * A recipe matches when menuItemId equals; if the item has a variantId, the recipe's variantId must
 * equal it, otherwise the recipe must be variant-less (item-level). Missing price -> 0. No recipe -> 0.
 */
export function computeCogs(
  items: CogsItem[],
  recipes: CogsRecipe[],
  purchasePriceByIngredient: Map<string, number>
): number {
  let total = 0;
  for (const item of items) {
    if (!item.menuItemId) continue;
    const matching = recipes.filter((r) => {
      if (r.menuItemId !== item.menuItemId) return false;
      return item.variantId ? r.variantId === item.variantId : !r.variantId;
    });
    for (const r of matching) {
      const price = purchasePriceByIngredient.get(r.ingredientId) ?? 0;
      total += r.qtyPerUnit * item.qty * price;
    }
  }
  return Math.round(total);
}
