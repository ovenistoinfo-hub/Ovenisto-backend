import { ApiError } from '../../utils/ApiError.js';

const TYPE_TO_DISPLAY: Record<string, string> = {
  DINE_IN: 'Dine In', TAKE_AWAY: 'Take Away', DELIVERY: 'Delivery',
  ONLINE: 'Online', SELF_ORDER: 'Self Order', FOODPANDA: 'Foodpanda', WALKIN: 'Walk-in',
};

/** Convert a Prisma OrderType enum member name (e.g. "DINE_IN") to its display string
 *  ("Dine In"). Passes through values that are already display strings or unknown. */
export function displayOrderType(type: string): string {
  return TYPE_TO_DISPLAY[type] ?? type;
}

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

export const ONLINE_TYPES = ['Foodpanda', 'Online', 'Self Order'];
export const OFFLINE_TYPES = ['Dine In', 'Take Away', 'Walk-in'];
// Channels shown as cards (mockup order). Walk-in is counted in offline totals but has no own card.
export const CHANNEL_ORDER = ['Dine In', 'Take Away', 'Delivery', 'Foodpanda', 'Self Order', 'Online'];

/** UTC start/end of the given calendar day. */
export function dayBoundaries(now: Date): { gte: Date; lte: Date } {
  const y = now.getUTCFullYear(), m = now.getUTCMonth(), d = now.getUTCDate();
  return {
    gte: new Date(Date.UTC(y, m, d, 0, 0, 0, 0)),
    lte: new Date(Date.UTC(y, m, d, 23, 59, 59, 999)),
  };
}

/** UTC ranges for this month and last month, from `now`. */
export function monthBoundaries(now: Date): { thisStart: Date; thisEnd: Date; lastStart: Date; lastEnd: Date } {
  const y = now.getUTCFullYear(), m = now.getUTCMonth();
  const thisStart = new Date(Date.UTC(y, m, 1, 0, 0, 0, 0));
  const thisEnd = new Date(Date.UTC(y, m + 1, 0, 23, 59, 59, 999)); // day 0 of next month = last day of this
  const lastStart = new Date(Date.UTC(y, m - 1, 1, 0, 0, 0, 0));
  const lastEnd = new Date(Date.UTC(y, m, 0, 23, 59, 59, 999));
  return { thisStart, thisEnd, lastStart, lastEnd };
}

/** Online vs offline by order type. Unknown types default to offline. */
export function classifyChannel(type: string): 'online' | 'offline' {
  return ONLINE_TYPES.includes(type) ? 'online' : 'offline';
}

/** Percentage change current vs previous; 0 when previous is 0 (avoids divide-by-zero). */
export function growthPct(current: number, previous: number): number {
  if (!previous) return 0;
  return Math.round(((current - previous) / previous) * 100);
}

/** Zero-fill every channel in CHANNEL_ORDER, merging provided rows. */
export function fillChannels(
  rows: { type: string; sales: number; orders: number }[]
): { type: string; sales: number; orders: number }[] {
  const byType = new Map(rows.map((r) => [r.type, r]));
  return CHANNEL_ORDER.map((type) => byType.get(type) ?? { type, sales: 0, orders: 0 });
}

/**
 * Reduce a messy POS payment string to a clean method name.
 * Real data looks like "Cash: Rs.400", "Advance (Cash): Rs.1500",
 * "Cash: Rs.1000, JazzCash: Rs.980" (split). We take the first segment (before a
 * comma), drop the amount (before a colon), and unwrap an "Advance (X)" wrapper.
 * Returns null for empty/null.
 */
export function normalizePaymentMethod(raw: string | null): string | null {
  if (!raw) return null;
  // first payment segment of a possible split ("Cash: x, JazzCash: y" -> "Cash: x")
  let s = raw.split(',')[0];
  // drop amount ("Cash: Rs.400" -> "Cash")
  s = s.split(':')[0];
  // unwrap "Advance (Cash)" -> "Cash"
  const m = s.match(/\(([^)]+)\)/);
  if (m) s = m[1];
  s = s.trim();
  return s.length ? s : null;
}

/** Sum amounts by payment method (normalized), ignoring empty methods; sorted desc, rounded. */
export function groupPayments(
  rows: { method: string | null; amount: number }[]
): { method: string; amount: number }[] {
  const map = new Map<string, number>();
  for (const r of rows) {
    const method = normalizePaymentMethod(r.method);
    if (!method) continue;
    map.set(method, (map.get(method) ?? 0) + r.amount);
  }
  return [...map.entries()]
    .map(([method, amount]) => ({ method, amount: Math.round(amount) }))
    .sort((a, b) => b.amount - a.amount);
}
