/**
 * Deal Pricing & Eligibility Kernel
 *
 * Pure, dependency-free helpers — no Prisma, no Express. This is the single
 * source of truth for "is this deal live right now" / "what does it cost on
 * this channel" / "does this selection match the deal's real contents", reused
 * by deal.controller.ts (admin sanity checks) and deal.revalidate.ts (the
 * server-authoritative re-pricing that runs on every order). The frontend's
 * `src/lib/deals.ts` mirrors this logic for display purposes only — the server
 * copy here is what actually gets charged.
 */

import { ApiError } from '../../utils/ApiError.js';

const PKT_OFFSET_MS = 5 * 60 * 60 * 1000;

function pktNow(nowMs: number): Date {
  return new Date(nowMs + PKT_OFFSET_MS);
}

/** "YYYY-MM-DD" for the given instant, in Pakistan time (server runs UTC). */
function pktDateStr(nowMs: number): string {
  return pktNow(nowMs).toISOString().split('T')[0];
}

/** Minutes since PKT midnight for the given instant. */
function pktMinutesOfDay(nowMs: number): number {
  const d = pktNow(nowMs);
  return d.getUTCHours() * 60 + d.getUTCMinutes();
}

function toDateStr(d: Date | string): string {
  return typeof d === 'string' ? d.slice(0, 10) : d.toISOString().split('T')[0];
}

function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

export function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

// ── Shared shapes ──

export interface ChannelPriced {
  price: number | null | undefined;
  dineInPrice?: number | null;
  takeAwayPrice?: number | null;
  deliveryPrice?: number | null;
  foodpandaPrice?: number | null;
}

const ORDER_TYPE_TO_FIELD: Record<string, keyof ChannelPriced> = {
  'Dine In': 'dineInPrice',
  'Take Away': 'takeAwayPrice',
  'Delivery': 'deliveryPrice',
  'Foodpanda': 'foodpandaPrice',
};

/** dineIn/takeAway/delivery/foodpanda channel price, falling back to the base
 *  `price` — mirrors POS.tsx's resolvePrice. Uses `??` (not `||`) so a real
 *  channel price of 0 is honored, not treated as "unset". */
export function resolveChannelPrice(record: ChannelPriced, orderType: string | undefined): number {
  const field = orderType ? ORDER_TYPE_TO_FIELD[orderType] : undefined;
  const channelPrice = field ? record[field] : undefined;
  return channelPrice ?? record.price ?? 0;
}

/** The percentage half of the same idea, for the two deal formats that discount
 *  live menu prices instead of selling at a flat bundle price. A PERCENTAGE deal
 *  varies its discountPercent per channel; a BUY_X_GET_Y deal varies how much of
 *  the free item it covers (base 100 = genuinely free). */
export interface ChannelDiscounted {
  dineInPercent?: number | null;
  takeAwayPercent?: number | null;
  deliveryPercent?: number | null;
  foodpandaPercent?: number | null;
}

const ORDER_TYPE_TO_PERCENT_FIELD: Record<string, keyof ChannelDiscounted> = {
  'Dine In': 'dineInPercent',
  'Take Away': 'takeAwayPercent',
  'Delivery': 'deliveryPercent',
  'Foodpanda': 'foodpandaPercent',
};

/** Channel discount % for this order type, falling back to `base` when the
 *  channel has no override. `??` again, so an explicit 0 ("no discount on
 *  Foodpanda") is honored rather than falling through to the base figure.
 *  Always clamped to 0–100 — a stale row can hold anything. */
export function resolveChannelPercent(
  record: ChannelDiscounted,
  orderType: string | undefined,
  base: number,
): number {
  const field = orderType ? ORDER_TYPE_TO_PERCENT_FIELD[orderType] : undefined;
  const override = field ? record[field] : undefined;
  return Math.min(100, Math.max(0, override ?? base));
}

export interface DealComponentForPricing {
  id: string;
  menuItemId: string;
  variantId: string | null;
  qty: number;
}

export interface DealOptionItemForPricing {
  id: string;
  menuItemId: string;
  variantId: string | null;
  extraPrice: number;
}

export interface DealOptionGroupForPricing {
  id: string;
  label: string;
  minSelections: number;
  maxSelections: number;
  options: DealOptionItemForPricing[];
}

export interface BogoItemForPricing {
  role: 'BUY' | 'GET';
  menuItemId: string;
  variantId?: string | null;
  qty: number;
  displayOrder?: number;
}

/** One item the customer must buy, or one they get free. */
export interface BogoSideItem {
  menuItemId: string;
  variantId: string | null;
  qty: number;
}

export type DealTypeMember = 'COMBO' | 'OPTION_COMBO' | 'PERCENTAGE' | 'BUY_X_GET_Y';

export interface DealForPricing extends ChannelPriced, ChannelDiscounted {
  id: string;
  type: DealTypeMember;
  isActive: boolean;
  status: string;
  validFrom: Date | string;
  validTo?: Date | string | null;
  startTime?: string | null;
  endTime?: string | null;
  components?: DealComponentForPricing[];
  optionGroups?: DealOptionGroupForPricing[];
  // PERCENTAGE
  discountPercent?: number | null;
  applicableItems?: string[];
  applicableCategories?: string[];
  // BUY_X_GET_Y
  /** Every item on both sides of the offer. Empty on legacy rows, which carry
   *  their single item in the flat buy/get fields below instead. */
  bogoItems?: BogoItemForPricing[];
  buyItemId?: string | null;
  /** Pins the "buy" side to one variant. Null = any variant qualifies (legacy rows). */
  buyVariantId?: string | null;
  buyQty?: number | null;
  getItemId?: string | null;
  /** Pins the free side to one variant. Null = any variant, capped at the cheapest one's price. */
  getVariantId?: string | null;
  getQty?: number | null;
}

export interface DealValidity {
  valid: boolean;
  reason?: string;
}

/** Is this deal sellable right now — active, not archived, inside its
 *  validFrom/validTo window and (if set) its startTime/endTime window.
 *  All date/time comparisons use Pakistan time, and the time window supports
 *  crossing midnight (e.g. 22:00–02:00). */
export function isDealCurrentlyValid(deal: DealForPricing, nowMs: number = Date.now()): DealValidity {
  if (deal.status === 'archived') return { valid: false, reason: 'This deal has been archived' };
  if (!deal.isActive) return { valid: false, reason: 'This deal is not currently active' };

  const today = pktDateStr(nowMs);
  const validFromStr = toDateStr(deal.validFrom);
  if (validFromStr > today) return { valid: false, reason: `This deal starts on ${validFromStr}` };

  if (deal.validTo) {
    const validToStr = toDateStr(deal.validTo);
    if (validToStr < today) return { valid: false, reason: 'This deal has expired' };
  }

  if (deal.startTime && deal.endTime) {
    const nowMinutes = pktMinutesOfDay(nowMs);
    const startMinutes = toMinutes(deal.startTime);
    const endMinutes = toMinutes(deal.endTime);
    const inWindow = startMinutes <= endMinutes
      ? nowMinutes >= startMinutes && nowMinutes < endMinutes
      : nowMinutes >= startMinutes || nowMinutes < endMinutes; // crosses midnight
    if (!inWindow) {
      return { valid: false, reason: `This deal is only available ${deal.startTime}–${deal.endTime}` };
    }
  }

  return { valid: true };
}

/** Splits `totalSavings` across `lineGrossAmounts` proportionally to each
 *  line's gross value, rounded to paisas, with the rounding remainder pushed
 *  onto the largest-weight line so the sum is always exactly `totalSavings`
 *  (clamped to >= 0). All-zero weights split evenly. */
export function allocateDealDiscount(totalSavings: number, lineGrossAmounts: number[]): number[] {
  if (lineGrossAmounts.length === 0) return [];
  const savings = Math.max(0, totalSavings);
  const weights = lineGrossAmounts.map((a) => Math.max(0, a));
  const totalWeight = weights.reduce((s, w) => s + w, 0);

  const shares = totalWeight > 0
    ? weights.map((w) => (savings * w) / totalWeight)
    : weights.map(() => savings / weights.length);

  const rounded = shares.map(round2);
  const remainder = round2(savings - rounded.reduce((s, v) => s + v, 0));

  let pivotIdx = 0;
  for (let i = 1; i < weights.length; i++) {
    if (weights[i] > weights[pivotIdx]) pivotIdx = i;
  }
  rounded[pivotIdx] = round2(rounded[pivotIdx] + remainder);
  return rounded;
}

export interface SubmittedDealPick {
  groupId?: string;
  menuItemId: string;
  variantId?: string | null;
  qty?: number;
}

export interface DealSelectionLine {
  menuItemId: string;
  variantId: string | null;
  qty: number;
  extraPrice: number;
}

/** Validates a client-submitted deal selection against the deal's REAL
 *  components/option groups and returns the normalized, trustworthy line
 *  list. Throws ApiError.badRequest on any tamper: an extra/missing/
 *  quantity-altered fixed-bundle component, an option pick outside its
 *  group's allow-list, or a group selection count outside min/maxSelections. */
export function validateDealSelection(deal: DealForPricing, submitted: SubmittedDealPick[]): DealSelectionLine[] {
  if (deal.type === 'COMBO') {
    const components = deal.components ?? [];
    if (submitted.length !== components.length) {
      throw ApiError.badRequest('Deal selection does not match this deal\'s fixed components');
    }
    return components.map((c) => {
      const match = submitted.find(
        (s) => s.menuItemId === c.menuItemId && (s.variantId ?? null) === (c.variantId ?? null)
      );
      if (!match) throw ApiError.badRequest('Deal selection does not match this deal\'s fixed components');
      const qty = match.qty ?? c.qty;
      if (qty !== c.qty) throw ApiError.badRequest('Deal component quantity cannot be changed');
      return { menuItemId: c.menuItemId, variantId: c.variantId ?? null, qty: c.qty, extraPrice: 0 };
    });
  }

  // OPTION_COMBO
  const groups = deal.optionGroups ?? [];
  const knownGroupIds = new Set(groups.map((g) => g.id));
  for (const s of submitted) {
    if (s.groupId && !knownGroupIds.has(s.groupId)) {
      throw ApiError.badRequest('Deal selection references an unknown option group');
    }
  }

  const lines: DealSelectionLine[] = [];
  for (const group of groups) {
    const picks = submitted.filter((s) => s.groupId === group.id);
    if (picks.length < group.minSelections || picks.length > group.maxSelections) {
      const need = group.minSelections === group.maxSelections
        ? `${group.minSelections}`
        : `${group.minSelections}-${group.maxSelections}`;
      throw ApiError.badRequest(`"${group.label}" requires ${need} selection(s)`);
    }
    for (const pick of picks) {
      const option = group.options.find(
        (o) => o.menuItemId === pick.menuItemId && (o.variantId ?? null) === (pick.variantId ?? null)
      );
      if (!option) throw ApiError.badRequest(`Selected item is not a valid choice for "${group.label}"`);
      const qty = Math.max(1, Math.trunc(pick.qty ?? 1));
      lines.push({ menuItemId: option.menuItemId, variantId: option.variantId ?? null, qty, extraPrice: option.extraPrice });
    }
  }
  return lines;
}

export interface CategorizedItem {
  menuItemId: string;
  categoryId: string | null;
}

/** Does this menu item/category qualify for a PERCENTAGE deal's
 *  discount? Matches if the item's id is in applicableItems, OR its category
 *  is in applicableCategories. Both lists empty never matches — an admin must
 *  explicitly scope the discount (enforced at the Zod layer too), so a
 *  misconfigured deal can't silently discount the entire menu. */
/** Flattens a Buy X Get Y deal into the two lists the rest of the code works
 *  with, regardless of which shape it was stored in.
 *
 *  A deal saved since the DealBogoItem relation existed carries every item
 *  there and may have several per side. A row written before it has exactly one
 *  item per side, held in the flat buyItemId/getItemId columns — those are read
 *  here so old deals keep working untouched. The relation wins whenever it has
 *  anything in it; the flat columns are only a mirror of its first row. */
export function resolveBogoSides(deal: DealForPricing): { buy: BogoSideItem[]; get: BogoSideItem[] } {
  const rows = deal.bogoItems ?? [];

  if (rows.length > 0) {
    const bySide = (role: 'BUY' | 'GET') =>
      rows
        .filter((r) => r.role === role)
        .slice()
        .sort((a, b) => (a.displayOrder ?? 0) - (b.displayOrder ?? 0))
        .map((r) => ({
          menuItemId: r.menuItemId,
          variantId: r.variantId ?? null,
          qty: Math.max(1, Math.trunc(r.qty || 1)),
        }));
    return { buy: bySide('BUY'), get: bySide('GET') };
  }

  const buy: BogoSideItem[] = deal.buyItemId
    ? [{
        menuItemId: deal.buyItemId,
        variantId: deal.buyVariantId ?? null,
        qty: Math.max(1, Math.trunc(deal.buyQty ?? 1)),
      }]
    : [];
  const get: BogoSideItem[] = deal.getItemId
    ? [{
        menuItemId: deal.getItemId,
        variantId: deal.getVariantId ?? null,
        qty: Math.max(1, Math.trunc(deal.getQty ?? 1)),
      }]
    : [];
  return { buy, get };
}

/** Does a submitted Buy X Get Y line satisfy the variant the deal pins it to?
 *
 *  A deal written since the *VariantId columns existed always pins both sides,
 *  so the submitted variant must match exactly. A legacy row pins nothing and
 *  means "any variant" — those pass here and are contained by capFreeUnitPrice
 *  on the giveaway side instead. */
export function matchesPinnedVariant(
  pinnedVariantId: string | null | undefined,
  submittedVariantId: string | null | undefined,
): boolean {
  if (!pinnedVariantId) return true;
  return submittedVariantId === pinnedVariantId;
}

/** How much of the free line the deal actually pays for.
 *
 *  A pinned deal gives away exactly the variant it names, so the whole line is
 *  free. An unpinned legacy deal could have meant any size, so it gives away no
 *  more than the cheapest one — a customer who takes a Large under an unpinned
 *  "get a pizza free" pays the difference over a Small rather than walking off
 *  with the priciest size at the restaurant's expense. */
export function capFreeUnitPrice(
  pinnedVariantId: string | null | undefined,
  submittedUnitPrice: number,
  cheapestVariantPrice: number,
): number {
  if (pinnedVariantId) return submittedUnitPrice;
  return Math.min(submittedUnitPrice, cheapestVariantPrice);
}

export function isItemEligibleForDiscount(deal: DealForPricing, item: CategorizedItem): boolean {
  const items = deal.applicableItems ?? [];
  const categories = deal.applicableCategories ?? [];
  if (items.length === 0 && categories.length === 0) return false;
  if (items.includes(item.menuItemId)) return true;
  if (item.categoryId && categories.includes(item.categoryId)) return true;
  return false;
}

const DEAL_TYPE_TO_WIRE: Record<string, string> = {
  COMBO: 'combo',
  OPTION_COMBO: 'option_combo',
  PERCENTAGE: 'percentage',
  BUY_X_GET_Y: 'buy_x_get_y',
};

/** Decimal → Number + enum-member → wire-string mapping for a Deal record
 *  (with or without nested components/optionGroups included). Prisma enums
 *  return the MEMBER name ("COMBO"), not the @map'd DB string — this is the
 *  same gotcha order.controller.ts's TYPE_TO_DISPLAY exists to fix. */
export function mapDealOut(deal: any): any {
  if (!deal) return deal;
  return {
    ...deal,
    type: DEAL_TYPE_TO_WIRE[deal.type] ?? deal.type,
    price: deal.price != null ? Number(deal.price) : null,
    dineInPrice: deal.dineInPrice != null ? Number(deal.dineInPrice) : null,
    takeAwayPrice: deal.takeAwayPrice != null ? Number(deal.takeAwayPrice) : null,
    deliveryPrice: deal.deliveryPrice != null ? Number(deal.deliveryPrice) : null,
    foodpandaPrice: deal.foodpandaPrice != null ? Number(deal.foodpandaPrice) : null,
    dineInPercent: deal.dineInPercent != null ? Number(deal.dineInPercent) : null,
    takeAwayPercent: deal.takeAwayPercent != null ? Number(deal.takeAwayPercent) : null,
    deliveryPercent: deal.deliveryPercent != null ? Number(deal.deliveryPercent) : null,
    foodpandaPercent: deal.foodpandaPercent != null ? Number(deal.foodpandaPercent) : null,
    discountPercent: deal.discountPercent != null ? Number(deal.discountPercent) : null,
    components: Array.isArray(deal.components)
      ? deal.components.map((c: any) => ({ ...c }))
      : undefined,
    optionGroups: Array.isArray(deal.optionGroups)
      ? deal.optionGroups.map((g: any) => ({
          ...g,
          options: Array.isArray(g.options)
            ? g.options.map((o: any) => ({ ...o, extraPrice: o.extraPrice != null ? Number(o.extraPrice) : 0 }))
            : [],
        }))
      : undefined,
  };
}

/** Public/self-order-safe mapping — strips internal channel prices
 *  (takeAway/delivery/foodpanda) and outletIds, and folds price down to a
 *  single customer-facing figure (dineIn, since self-order is always
 *  dine-in). Never expose mapDealOut()'s full shape on an unauthenticated
 *  route — mirrors self-order.controller.ts's getSelfOrderMenu warning. */
export function mapDealOutPublic(deal: any): any {
  const mapped = mapDealOut(deal);
  const {
    dineInPrice, takeAwayPrice, deliveryPrice, foodpandaPrice,
    dineInPercent, takeAwayPercent, deliveryPercent, foodpandaPercent,
    outletIds, status, ...rest
  } = mapped;
  return {
    ...rest,
    price: dineInPrice ?? mapped.price,
    // Self-order is always dine-in, so fold that channel's override down into
    // the single customer-facing percentage. Only for a PERCENTAGE deal — on a
    // BUY_X_GET_Y row the same column means "how much of the free item we
    // cover", which is not a discount on this deal's own price.
    discountPercent:
      mapped.type === 'percentage' ? dineInPercent ?? mapped.discountPercent : mapped.discountPercent,
  };
}
