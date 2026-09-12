import { ApiError } from '../../utils/ApiError.js';
import { parsePaymentMethodAmounts } from '../cash-settlement/cash-settlement.service.js';

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

/**
 * Parse inclusive from/to (YYYY-MM-DD) into UTC instants bounding that PKT calendar-day range.
 * `from`/`to` are PKT wall-clock dates (the frontend derives them from the browser's local
 * clock), but `Order.createdAt` is a real UTC timestamp — so the window is shifted -5h (PKT =
 * UTC+5) to land on true PKT midnight, not UTC midnight. Without this shift, any order placed
 * between 00:00-05:00 PKT is misattributed to the previous calendar day everywhere under
 * /api/reports/* (see CLAUDE.md's "PKT Timezone Pattern" — the same class of bug documented
 * there for attendance/leave dates). Throws ApiError on invalid input.
 */
export function parseDateRange(from: string | undefined, to: string | undefined): DateRange {
  if (!from || !to) {
    throw ApiError.badRequest('from and to are required (YYYY-MM-DD)');
  }
  const gte = new Date(`${from}T00:00:00.000Z`);
  const lte = new Date(`${to}T23:59:59.999Z`);
  if (isNaN(gte.getTime()) || isNaN(lte.getTime())) {
    throw ApiError.badRequest('from and to must be valid dates (YYYY-MM-DD)');
  }
  const PKT_OFFSET_MS = 5 * 60 * 60 * 1000;
  return { gte: new Date(gte.getTime() - PKT_OFFSET_MS), lte: new Date(lte.getTime() - PKT_OFFSET_MS) };
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
 * A recipe matches when menuItemId equals; if the item has a variantId, a variant-specific recipe
 * row matches AND a variant-less (item-level) row still matches too (shared base-ingredient recipe
 * that applies regardless of size) -- mirrors order.controller.ts's validateOrderStock, which uses
 * this identical fallback. Without it, a menu item whose recipe was only ever defined once at the
 * item level (never duplicated per size) silently costs 0 for every order line that carries a
 * variantId, while an otherwise-identical variant-less line for the same item costs correctly --
 * exactly what made a Self-Order (which always sends a real variantId once a size is picked) line
 * report Rs. 0 cost while a POS "Add Without Extras" line (variantId: null) for the same pizza
 * costed correctly. Missing price -> 0. No matching recipe at all -> 0.
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
      return item.variantId ? (!r.variantId || r.variantId === item.variantId) : !r.variantId;
    });
    for (const r of matching) {
      const price = purchasePriceByIngredient.get(r.ingredientId) ?? 0;
      total += r.qtyPerUnit * item.qty * price;
    }
  }
  return Math.round(total);
}

/**
 * Split one order's final `total` (tax- AND discount-inclusive) across its line items in
 * proportion to each line's gross value (unit price × qty − line discount), so the returned
 * parts sum back to `Math.round(orderTotal)` exactly — the last positive-weight line absorbs
 * the rounding remainder, so no rupee is lost or invented.
 *
 * Used to attribute an order's revenue to the food category of each line (Sales-by-Category
 * report + the Sales & Orders page's category-scoped columns): a single "Pizza + Coke" order
 * puts its Pizza share in the Pizza bucket and its Coke share in Beverages, and the two shares
 * add back to the order total. Prorating the *final total* — rather than handling the
 * order-level discount and tax separately — keeps this figure identical in meaning to
 * getSalesByChannel's Sale (which sums Order.total per order), so the two dashboard sections
 * stay reconcilable.
 *
 * Degenerate input (every line gross ≤ 0, e.g. a fully comped order) falls back to an equal
 * split so the total is still fully attributed rather than dropped. Empty input → [].
 */
export function splitOrderTotalByLine(orderTotal: number, lineGross: number[]): number[] {
  const n = lineGross.length;
  if (n === 0) return [];
  const target = Math.round(orderTotal);
  const clamped = lineGross.map((g) => (g > 0 ? g : 0));
  const sum = clamped.reduce((s, g) => s + g, 0);
  const weights = sum > 0 ? clamped.map((g) => g / sum) : clamped.map(() => 1 / n);
  const out = weights.map((w) => Math.round(target * w));
  const drift = target - out.reduce((s, v) => s + v, 0);
  if (drift !== 0) {
    let idx = n - 1;
    while (idx > 0 && weights[idx] === 0) idx--;
    out[idx] += drift;
  }
  return out;
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

/** True when stock is at or below the low-stock threshold. */
export function isLowStock(currentStock: number, lowStockLevel: number): boolean {
  return currentStock <= lowStockLevel;
}

/**
 * Parse "HH:MM" (24-hour) into minutes-since-midnight.
 * Returns null when t is undefined or empty (no time filter).
 * Throws ApiError 400 on a malformed string.
 */
export function parseTimeOfDay(t: string | undefined): number | null {
  if (!t || t.trim() === '') return null;
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(t.trim());
  if (!match) {
    throw ApiError.badRequest(`Invalid time format "${t}" — expected HH:MM (24h)`);
  }
  return parseInt(match[1], 10) * 60 + parseInt(match[2], 10);
}

/**
 * Returns true if the order's PKT creation time falls within [fromMin, toMin).
 * Returns true unconditionally when either bound is null (no filter applied).
 * Shifts createdAt to PKT (+5 h) using the same getUTCHours/getUTCMinutes-on-shifted-Date
 * pattern used throughout this codebase (see CLAUDE.md "PKT Timezone Pattern").
 * Handles midnight-crossing windows (fromMin > toMin, e.g. 22:00→02:00) the same way
 * isDealCurrentlyValid handles a deal's overnight time window.
 */
export function isWithinTimeOfDay(
  createdAt: Date,
  fromMin: number | null,
  toMin: number | null,
): boolean {
  if (fromMin === null || toMin === null) return true;
  // Shift UTC → PKT (+5 h)
  const pkt = new Date(createdAt.getTime() + 5 * 60 * 60 * 1000);
  const minutes = pkt.getUTCHours() * 60 + pkt.getUTCMinutes();
  if (fromMin <= toMin) {
    // Normal window, e.g. 09:00–17:00
    return minutes >= fromMin && minutes < toMin;
  }
  // Midnight-crossing window, e.g. 22:00–02:00
  return minutes >= fromMin || minutes < toMin;
}

/**
 * Default payment-method buckets used when grouping payments (mirrors the fallback list in
 * cash-settlement.service.ts's getActiveBalances/getStaffActiveBalance). Only affects alias
 * canonicalization (e.g. "card" -> "Credit Card") — parsePaymentMethodAmounts falls back to the
 * raw extracted label for anything not on this list, so no amount is ever lost because a method
 * name isn't in it.
 */
const DEFAULT_PAYMENT_METHODS = ['Cash', 'Credit Card', 'Account', 'JazzCash', 'EasyPaisa'];

/**
 * Sum amounts by payment method across many orders.
 *
 * Reuses cash-settlement.service.ts's parsePaymentMethodAmounts — the SAME parser Cash Hub
 * settlement relies on — per order, instead of an independently-maintained re-derivation. This
 * fixes two real bugs the previous normalizePaymentMethod/groupPayments here had:
 *  1. A genuine split ("Cash: Rs.1000, JazzCash: Rs.980") now credits BOTH methods their own
 *     parsed amount, instead of taking only the first comma segment and dumping the ENTIRE
 *     order total on it (silently dropping the rest from the dashboard breakdown).
 *  2. A delivered-COD string like "Advance (JazzCash: Rs.507), COD Balance (Cash): Rs.1000" now
 *     yields clean "JazzCash"/"Cash" labels, instead of a garbled "Advance (JazzCash" (truncated
 *     before the closing paren by the old split(',')[0].split(':')[0] logic).
 * A null/empty method defaults to Cash (parsePaymentMethodAmounts' own convention, matching how
 * Cash Hub treats a missing payment method) rather than being silently dropped from the total.
 * Ignores non-positive per-method amounts. Sorted desc, rounded.
 */
/**
 * Sum amounts by payment method across many orders AND count how many orders contributed a
 * positive amount to each method. Same canonical parse as {@link groupPayments} (which is now a
 * thin wrapper over this) — a genuine split ("Cash: Rs.1000, JazzCash: Rs.980") credits BOTH
 * methods their own parsed amount and counts toward BOTH methods' `orders`. So `Σ orders` across
 * methods can exceed the number of input rows; a caller wanting a distinct-order total should
 * use the row count. A null/empty method defaults to Cash (parsePaymentMethodAmounts' own
 * convention). Non-positive per-method amounts ignored. Sorted by amount desc, rounded.
 */
export function groupPaymentsWithCounts(
  rows: { method: string | null; amount: number }[]
): { method: string; amount: number; orders: number }[] {
  const amtByMethod = new Map<string, number>();
  const cntByMethod = new Map<string, number>();
  for (const r of rows) {
    if (!r.amount) continue;
    const parsed = parsePaymentMethodAmounts(r.method, r.amount, DEFAULT_PAYMENT_METHODS);
    for (const [method, amt] of Object.entries(parsed)) {
      if (amt <= 0) continue;
      amtByMethod.set(method, (amtByMethod.get(method) ?? 0) + amt);
      cntByMethod.set(method, (cntByMethod.get(method) ?? 0) + 1);
    }
  }
  return [...amtByMethod.entries()]
    .map(([method, amount]) => ({ method, amount: Math.round(amount), orders: cntByMethod.get(method) ?? 0 }))
    .sort((a, b) => b.amount - a.amount);
}

/** {@link groupPaymentsWithCounts} without the per-method order count — the shape getDashboard's
 *  paymentBreakdown has always returned. */
export function groupPayments(
  rows: { method: string | null; amount: number }[]
): { method: string; amount: number }[] {
  return groupPaymentsWithCounts(rows).map(({ method, amount }) => ({ method, amount }));
}

/**
 * True when `wanted` payment method contributed a positive amount to this order — parsing the
 * order's paymentMethod string with the SAME canonical parser groupPayments uses. So a split
 * ("Cash: Rs.900, JazzCash: Rs.779") matches BOTH "Cash" and "JazzCash", and — critically —
 * filtering "Cash" never matches a "JazzCash" order (a plain substring test would, since
 * "JazzCash" contains "cash"; CLAUDE.md flags this exact trap). Case-insensitive on the method
 * name. A null/blank methodString never matches (an unpaid order carries no real payment, and
 * Sales & Orders excludes it via excludeUnpaid anyway). Powers GET /api/orders' `paymentMethod`
 * filter (the Dashboard "Sales by Payment Method" drill-down).
 */
export function orderUsedPaymentMethod(
  methodString: string | null,
  orderTotal: number,
  wanted: string,
): boolean {
  if (!methodString || !methodString.trim()) return false;
  const parsed = parsePaymentMethodAmounts(methodString, orderTotal, DEFAULT_PAYMENT_METHODS);
  const target = wanted.trim().toLowerCase();
  return Object.entries(parsed).some(([m, amt]) => amt > 0 && m.toLowerCase() === target);
}
