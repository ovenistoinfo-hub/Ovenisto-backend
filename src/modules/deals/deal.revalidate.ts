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
  allocateDealDiscount,
  validateDealSelection,
  isItemEligibleForDiscount,
  type DealForPricing,
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
    buyItemId: deal.buyItemId ?? null,
    buyQty: deal.buyQty ?? null,
    getItemId: deal.getItemId ?? null,
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
    include: { components: true, optionGroups: { include: { options: true } } },
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

    if (dealForPricing.type === 'PERCENTAGE' || dealForPricing.type === 'TIME_BASED') {
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

/** PERCENTAGE / TIME_BASED: one submitted item per dealLineId — the real menu
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
  const percent = dealForPricing.discountPercent ?? 0;
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

/** BUY_X_GET_Y: exactly two submitted items per dealLineId, disambiguated by
 *  dealRole — the "buy" line (must be >= buyQty of buyItemId) and the "get"
 *  line (must be <= getQty of getItemId, priced free). */
function revalidateBuyXGetYLine(
  deal: any, dealForPricing: DealForPricing, lineItems: IncomingOrderItem[], lineId: string,
  menuItemById: Map<string, any>, orderType: string | undefined,
): IncomingOrderItem[] {
  const buyItem = lineItems.find((i) => i.dealRole === 'buy');
  const getItem = lineItems.find((i) => i.dealRole === 'get');
  if (lineItems.length !== 2 || !buyItem || !getItem) {
    throw ApiError.badRequest(`"${deal.name}" needs both a "buy" and a "get" line`);
  }

  if (buyItem.menuItemId !== dealForPricing.buyItemId) {
    throw ApiError.badRequest(`"${deal.name}"'s "buy" item does not match`);
  }
  const buyQtyNeeded = dealForPricing.buyQty ?? 1;
  const buyQty = Math.max(1, Math.trunc(buyItem.qty));
  if (buyQty < buyQtyNeeded) {
    throw ApiError.badRequest(`"${deal.name}" requires buying at least ${buyQtyNeeded}`);
  }

  if (getItem.menuItemId !== dealForPricing.getItemId) {
    throw ApiError.badRequest(`"${deal.name}"'s "get" item does not match`);
  }
  const getQtyAllowed = dealForPricing.getQty ?? 1;
  const getQty = Math.max(1, Math.trunc(getItem.qty));
  if (getQty > getQtyAllowed) {
    throw ApiError.badRequest(`"${deal.name}" gives at most ${getQtyAllowed} free`);
  }

  const buyMenuItem: any = menuItemById.get(buyItem.menuItemId as string);
  const getMenuItem: any = menuItemById.get(getItem.menuItemId as string);
  if (!buyMenuItem || !getMenuItem) throw ApiError.badRequest(`A menu item in "${deal.name}" is no longer available`);

  const buyUnitPrice = resolveLinePrice(buyMenuItem, buyItem.variantId, orderType);
  const buyVariant = buyItem.variantId ? buyMenuItem.variants.find((v: any) => v.id === buyItem.variantId) : undefined;

  const getUnitPrice = resolveLinePrice(getMenuItem, getItem.variantId, orderType);
  const getVariant = getItem.variantId ? getMenuItem.variants.find((v: any) => v.id === getItem.variantId) : undefined;

  return [
    {
      menuItemId: buyMenuItem.id,
      variantId: buyItem.variantId ?? null,
      name: `${buyMenuItem.name}${buyVariant ? ` (${buyVariant.name})` : ''}`,
      price: buyUnitPrice,
      qty: buyQty,
      discount: 0,
      modifiers: [],
      dealId: deal.id,
      dealName: deal.name,
      dealLineId: lineId,
    },
    {
      menuItemId: getMenuItem.id,
      variantId: getItem.variantId ?? null,
      name: `${deal.name}: ${getMenuItem.name}${getVariant ? ` (${getVariant.name})` : ''} (Free)`,
      price: getUnitPrice,
      qty: getQty,
      discount: getUnitPrice * getQty,
      modifiers: [],
      dealId: deal.id,
      dealName: deal.name,
      dealLineId: lineId,
    },
  ];
}
