/**
 * Deal Re-validation — the enforcement seam order.controller.ts and
 * self-order.controller.ts both call before persisting any order that
 * contains deal-tagged items. Never trusts a client-sent deal price,
 * discount, or component selection: every deal line is re-derived from the
 * live Deal record and live FoodMenuItem/FoodMenuVariant prices.
 */

import type { Prisma } from '@prisma/client';
import { prisma } from '../../config/database.js';
import { ApiError } from '../../utils/ApiError.js';
import {
  isDealCurrentlyValid,
  resolveChannelPrice,
  resolveChannelPercent,
  round2,
  allocateDealDiscount,
  validateDealSelection,
  isItemEligibleForDiscount,
  matchesPinnedVariant,
  capFreeUnitPrice,
  resolveBogoSides,
  type DealForPricing,
  type BogoSideItem,
} from './deal.pricing.js';

export interface IncomingOrderItem {
  menuItemId?: string | null;
  variantId?: string | null;
  name?: string;
  price?: number;
  qty: number;
  discount?: number;
  modifiers?: string[];
  modifierIds?: unknown;
  cookingTime?: number | null;
  notes?: string | null;
  dealId?: string | null;
  dealName?: string | null;
  dealLineId?: string | null;
  /** Which option group this pick belongs to — validation-only, never persisted to OrderItem. */
  dealGroupId?: string | null;
  /** BUY_X_GET_Y only: which side of the offer this submitted line is — validation-only, never persisted. */
  dealRole?: 'buy' | 'get' | null;
}

function toDealForPricing(deal: any): DealForPricing {
  return {
    id: deal.id,
    type: deal.type,
    price: deal.price != null ? Number(deal.price) : null,
    dineInPrice: deal.dineInPrice != null ? Number(deal.dineInPrice) : null,
    takeAwayPrice: deal.takeAwayPrice != null ? Number(deal.takeAwayPrice) : null,
    deliveryPrice: deal.deliveryPrice != null ? Number(deal.deliveryPrice) : null,
    foodpandaPrice: deal.foodpandaPrice != null ? Number(deal.foodpandaPrice) : null,
    dineInPercent: deal.dineInPercent != null ? Number(deal.dineInPercent) : null,
    takeAwayPercent: deal.takeAwayPercent != null ? Number(deal.takeAwayPercent) : null,
    deliveryPercent: deal.deliveryPercent != null ? Number(deal.deliveryPercent) : null,
    foodpandaPercent: deal.foodpandaPercent != null ? Number(deal.foodpandaPercent) : null,
    isActive: deal.isActive,
    status: deal.status,
    validFrom: deal.validFrom,
    validTo: deal.validTo,
    startTime: deal.startTime,
    endTime: deal.endTime,
    components: (deal.components ?? []).map((c: any) => ({
      id: c.id, menuItemId: c.menuItemId, variantId: c.variantId, qty: c.qty,
    })),
    optionGroups: (deal.optionGroups ?? []).map((g: any) => ({
      id: g.id, label: g.label, minSelections: g.minSelections, maxSelections: g.maxSelections,
      options: (g.options ?? []).map((o: any) => ({
        id: o.id, menuItemId: o.menuItemId, variantId: o.variantId, extraPrice: Number(o.extraPrice),
      })),
    })),
    discountPercent: deal.discountPercent != null ? Number(deal.discountPercent) : null,
    applicableItems: deal.applicableItems ?? [],
    applicableCategories: deal.applicableCategories ?? [],
    bogoItems: (deal.bogoItems ?? []).map((b: any) => ({
      role: b.role, menuItemId: b.menuItemId, variantId: b.variantId, qty: b.qty, displayOrder: b.displayOrder,
    })),
    buyItemId: deal.buyItemId ?? null,
    buyVariantId: deal.buyVariantId ?? null,
    buyQty: deal.buyQty ?? null,
    getItemId: deal.getItemId ?? null,
    getVariantId: deal.getVariantId ?? null,
    getQty: deal.getQty ?? null,
  };
}

function menuItemChannelRecord(menuItem: any) {
  return {
    price: Number(menuItem.price),
    dineInPrice: menuItem.dineInPrice != null ? Number(menuItem.dineInPrice) : null,
    takeAwayPrice: menuItem.takeAwayPrice != null ? Number(menuItem.takeAwayPrice) : null,
    deliveryPrice: menuItem.deliveryPrice != null ? Number(menuItem.deliveryPrice) : null,
    foodpandaPrice: menuItem.foodpandaPrice != null ? Number(menuItem.foodpandaPrice) : null,
  };
}

function resolveLinePrice(menuItem: any, variantId: string | null | undefined, orderType: string | undefined): number {
  if (variantId) {
    const variant = menuItem.variants.find((v: any) => v.id === variantId);
    if (!variant) throw ApiError.badRequest(`A menu item is no longer available`);
    return resolveChannelPrice(menuItemChannelRecord(variant), orderType);
  }
  return resolveChannelPrice(menuItemChannelRecord(menuItem), orderType);
}

/** The lowest price any variant of this item sells for on this channel — the
 *  ceiling on what an unpinned legacy Buy X Get Y deal may give away. Items
 *  with no variants have exactly one price, which is that ceiling. */
function cheapestUnitPrice(menuItem: any, orderType: string | undefined): number {
  const variants = menuItem.variants ?? [];
  if (variants.length === 0) return resolveChannelPrice(menuItemChannelRecord(menuItem), orderType);
  return Math.min(...variants.map((v: any) => resolveChannelPrice(menuItemChannelRecord(v), orderType)));
}

/**
 * Re-derives every deal-tagged item group (grouped by dealLineId) from the
 * live Deal + menu records, and returns the full item array with those
 * groups replaced by verified, correctly-priced component lines. Items with
 * no dealId/dealLineId pass through untouched — this pass deliberately does
 * NOT re-price ordinary items (see order.controller.ts's createOrder for why
 * that's a separate, larger, descoped problem).
 */
export async function revalidateDealLines(
  tx: Prisma.TransactionClient | typeof prisma,
  orderType: string | undefined,
  items: IncomingOrderItem[],
): Promise<IncomingOrderItem[]> {
  const dealLines = items.filter((i) => i.dealId && i.dealLineId);
  if (dealLines.length === 0) return items;

  const passThrough = items.filter((i) => !i.dealId || !i.dealLineId);

  const dealIds = Array.from(new Set(dealLines.map((i) => i.dealId as string)));
  const deals = await (tx as any).deal.findMany({
    where: { id: { in: dealIds } },
    include: { components: true, optionGroups: { include: { options: true } }, bogoItems: true },
  });
  const dealById = new Map(deals.map((d: any) => [d.id, d]));

  const menuItemIds = Array.from(new Set(dealLines.map((i) => i.menuItemId).filter(Boolean))) as string[];
  const menuItems = menuItemIds.length
    ? await (tx as any).foodMenuItem.findMany({ where: { id: { in: menuItemIds } }, include: { variants: true } })
    : [];
  const menuItemById: Map<string, any> = new Map(menuItems.map((m: any) => [m.id, m]));

  const lineIds = Array.from(new Set(dealLines.map((i) => i.dealLineId as string)));
  const revalidated: IncomingOrderItem[] = [];

  for (const lineId of lineIds) {
    const lineItems = dealLines.filter((i) => i.dealLineId === lineId);
    const dealId = lineItems[0].dealId as string;
    const deal: any = dealById.get(dealId);
    if (!deal) throw ApiError.badRequest('One of the deals in this order no longer exists');

    const dealForPricing = toDealForPricing(deal);
    const validity = isDealCurrentlyValid(dealForPricing);
    if (!validity.valid) throw ApiError.badRequest(validity.reason ? `"${deal.name}": ${validity.reason}` : `"${deal.name}" is not currently available`);

    if (dealForPricing.type === 'PERCENTAGE') {
      revalidated.push(...revalidatePercentageLine(deal, dealForPricing, lineItems, lineId, menuItemById, orderType));
    } else if (dealForPricing.type === 'BUY_X_GET_Y') {
      revalidated.push(...revalidateBuyXGetYLine(deal, dealForPricing, lineItems, lineId, menuItemById, orderType));
    } else {
      revalidated.push(...revalidateComboLine(deal, dealForPricing, lineItems, lineId, menuItemById, orderType));
    }
  }

  return [...passThrough, ...revalidated];
}

function revalidateComboLine(
  deal: any, dealForPricing: DealForPricing, lineItems: IncomingOrderItem[], lineId: string,
  menuItemById: Map<string, any>, orderType: string | undefined,
): IncomingOrderItem[] {
  const submitted = lineItems.map((i) => ({
    groupId: i.dealGroupId ?? undefined,
    menuItemId: i.menuItemId as string,
    variantId: i.variantId ?? null,
    qty: i.qty,
  }));
  const selection = validateDealSelection(dealForPricing, submitted);

  const dealPrice = resolveChannelPrice(dealForPricing, orderType);

  const grossAmounts: number[] = [];
  for (const line of selection) {
    const menuItem: any = menuItemById.get(line.menuItemId);
    if (!menuItem) throw ApiError.badRequest(`A menu item in "${deal.name}" is no longer available`);
    const unitPrice = resolveLinePrice(menuItem, line.variantId, orderType) + line.extraPrice;
    grossAmounts.push(unitPrice * line.qty);
  }

  const grossTotal = grossAmounts.reduce((s, v) => s + v, 0);
  const savings = Math.max(0, grossTotal - dealPrice);
  const discounts = allocateDealDiscount(savings, grossAmounts);

  return selection.map((line, idx) => {
    const menuItem: any = menuItemById.get(line.menuItemId);
    const variant = line.variantId ? menuItem.variants.find((v: any) => v.id === line.variantId) : undefined;
    const unitPrice = grossAmounts[idx] / line.qty;
    return {
      menuItemId: line.menuItemId,
      variantId: line.variantId,
      name: `${deal.name}: ${menuItem.name}${variant ? ` (${variant.name})` : ''}`,
      price: unitPrice,
      qty: line.qty,
      discount: discounts[idx],
      modifiers: [],
      dealId: deal.id,
      dealName: deal.name,
      dealLineId: lineId,
    };
  });
}

/** PERCENTAGE: one submitted item per dealLineId — the real menu
 *  item the customer wants the discount applied to. Never trusts the
 *  client's claim that the item qualifies; re-checks against the deal's live
 *  applicableItems/applicableCategories. */
function revalidatePercentageLine(
  deal: any, dealForPricing: DealForPricing, lineItems: IncomingOrderItem[], lineId: string,
  menuItemById: Map<string, any>, orderType: string | undefined,
): IncomingOrderItem[] {
  if (lineItems.length !== 1) {
    throw ApiError.badRequest(`"${deal.name}" applies to one item at a time`);
  }
  const item = lineItems[0];
  const menuItem: any = item.menuItemId ? menuItemById.get(item.menuItemId) : null;
  if (!menuItem) throw ApiError.badRequest(`A menu item in "${deal.name}" is no longer available`);

  const eligible = isItemEligibleForDiscount(dealForPricing, { menuItemId: menuItem.id, categoryId: menuItem.categoryId ?? null });
  if (!eligible) throw ApiError.badRequest(`This item is not eligible for "${deal.name}"`);

  const qty = Math.max(1, Math.trunc(item.qty));
  const unitPrice = resolveLinePrice(menuItem, item.variantId, orderType);
  // A channel may discount harder (or not at all) than the deal's base rate.
  const percent = resolveChannelPercent(dealForPricing, orderType, dealForPricing.discountPercent ?? 0);
  const discount = Math.min(unitPrice * qty, unitPrice * qty * (percent / 100));

  const variant = item.variantId ? menuItem.variants.find((v: any) => v.id === item.variantId) : undefined;
  return [{
    menuItemId: menuItem.id,
    variantId: item.variantId ?? null,
    name: `${deal.name}: ${menuItem.name}${variant ? ` (${variant.name})` : ''}`,
    price: unitPrice,
    qty,
    discount,
    modifiers: [],
    dealId: deal.id,
    dealName: deal.name,
    dealLineId: lineId,
  }];
}

/** BUY_X_GET_Y: the submitted lines for one dealLineId, split by dealRole into
 *  the things the customer bought and the things they are getting free.
 *
 *  Both sides can hold several items — "Buy 1 Pizza + 1 Pasta, get 1 Drink +
 *  1 Fries free" is one deal, not four. Every configured BUY row must be
 *  present in at least the quantity the deal asks for, and every submitted GET
 *  line must correspond to a configured GET row and stay within its quantity.
 *
 *  Each row is matched on variant as well as item. Matching only the item let a
 *  customer qualify with the cheapest size and claim the priciest one free —
 *  "Buy 1 Pizza, Get 1 Pizza Free" bought as a Small and taken as a Large.
 *  Rows that pin no variant (legacy deals) still accept any size, but their
 *  giveaway is capped at the cheapest one. */
function revalidateBuyXGetYLine(
  deal: any, dealForPricing: DealForPricing, lineItems: IncomingOrderItem[], lineId: string,
  menuItemById: Map<string, any>, orderType: string | undefined,
): IncomingOrderItem[] {
  const { buy: buyRows, get: getRows } = resolveBogoSides(dealForPricing);
  if (buyRows.length === 0 || getRows.length === 0) {
    throw ApiError.badRequest(`"${deal.name}" is not configured correctly`);
  }

  const submittedBuy = lineItems.filter((i) => i.dealRole === 'buy');
  const submittedGet = lineItems.filter((i) => i.dealRole === 'get');
  if (submittedBuy.length === 0 || submittedGet.length === 0) {
    throw ApiError.badRequest(`"${deal.name}" needs both a "buy" and a "get" line`);
  }
  if (submittedBuy.length + submittedGet.length !== lineItems.length) {
    throw ApiError.badRequest(`"${deal.name}" has a line that is neither bought nor free`);
  }

  /** Finds the configured row a submitted line is claiming against, consuming it
   *  so two submitted lines can never both satisfy the same row. */
  const takeMatchingRow = (rows: BogoSideItem[], used: boolean[], item: IncomingOrderItem) => {
    const idx = rows.findIndex(
      (row, i) =>
        !used[i] &&
        row.menuItemId === item.menuItemId &&
        matchesPinnedVariant(row.variantId, item.variantId ?? null),
    );
    if (idx === -1) return null;
    used[idx] = true;
    return rows[idx];
  };

  const out: IncomingOrderItem[] = [];

  // --- the things they have to buy ---
  const buyUsed = buyRows.map(() => false);
  for (const item of submittedBuy) {
    const row = takeMatchingRow(buyRows, buyUsed, item);
    if (!row) throw ApiError.badRequest(`"${deal.name}"'s "buy" items do not match the offer`);

    const qty = Math.max(1, Math.trunc(item.qty));
    if (qty < row.qty) {
      throw ApiError.badRequest(`"${deal.name}" requires buying at least ${row.qty} of each listed item`);
    }

    const menuItem: any = menuItemById.get(row.menuItemId);
    if (!menuItem) throw ApiError.badRequest(`A menu item in "${deal.name}" is no longer available`);

    const unitPrice = resolveLinePrice(menuItem, item.variantId, orderType);
    const variant = item.variantId ? menuItem.variants.find((v: any) => v.id === item.variantId) : undefined;

    out.push({
      menuItemId: menuItem.id,
      variantId: item.variantId ?? null,
      name: `${menuItem.name}${variant ? ` (${variant.name})` : ''}`,
      price: unitPrice,
      qty,
      discount: 0,
      modifiers: [],
      dealId: deal.id,
      dealName: deal.name,
      dealLineId: lineId,
    });
  }
  if (buyUsed.some((u) => !u)) {
    throw ApiError.badRequest(`"${deal.name}" requires buying every item the offer lists`);
  }

  // --- the things they get free ---
  const getUsed = getRows.map(() => false);
  for (const item of submittedGet) {
    const row = takeMatchingRow(getRows, getUsed, item);
    if (!row) throw ApiError.badRequest(`"${deal.name}"'s free items do not match the offer`);

    const qty = Math.max(1, Math.trunc(item.qty));
    if (qty > row.qty) {
      throw ApiError.badRequest(`"${deal.name}" gives at most ${row.qty} of that item free`);
    }

    const menuItem: any = menuItemById.get(row.menuItemId);
    if (!menuItem) throw ApiError.badRequest(`A menu item in "${deal.name}" is no longer available`);

    const unitPrice = resolveLinePrice(menuItem, item.variantId, orderType);
    const variant = item.variantId ? menuItem.variants.find((v: any) => v.id === item.variantId) : undefined;
    // A row that pins no variant could have meant any size, so cap what it
    // gives away at the cheapest; anything above that the customer pays.
    const cappedUnitPrice = capFreeUnitPrice(
      row.variantId,
      unitPrice,
      cheapestUnitPrice(menuItem, orderType),
    );
    // The giveaway is fully free by default, but a channel can cover only part
    // of it (e.g. half price on Foodpanda instead of free).
    const coveragePercent = resolveChannelPercent(dealForPricing, orderType, 100);
    const freeUnitPrice = round2(cappedUnitPrice * (coveragePercent / 100));

    out.push({
      menuItemId: menuItem.id,
      variantId: item.variantId ?? null,
      // Only call it free when the deal covers the whole line — a capped legacy
      // giveaway leaves the customer paying the difference.
      name: `${deal.name}: ${menuItem.name}${variant ? ` (${variant.name})` : ''}${
        freeUnitPrice <= 0 ? '' : freeUnitPrice >= unitPrice ? ' (Free)' : ' (Discounted)'
      }`,
      price: unitPrice,
      qty,
      discount: freeUnitPrice * qty,
      modifiers: [],
      dealId: deal.id,
      dealName: deal.name,
      dealLineId: lineId,
    });
  }

  return out;
}
