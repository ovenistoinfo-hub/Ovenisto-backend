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
}

function toDealForPricing(deal: any): DealForPricing {
  return {
    id: deal.id,
    type: deal.type,
    price: Number(deal.price),
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
  const menuItemById = new Map(menuItems.map((m: any) => [m.id, m]));

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

      let unitPrice = resolveChannelPrice(menuItemChannelRecord(menuItem), orderType);
      if (line.variantId) {
        const variant = menuItem.variants.find((v: any) => v.id === line.variantId);
        if (!variant) throw ApiError.badRequest(`A menu item in "${deal.name}" is no longer available`);
        unitPrice = resolveChannelPrice(menuItemChannelRecord(variant), orderType);
      }
      unitPrice += line.extraPrice;
      grossAmounts.push(unitPrice * line.qty);
    }

    const grossTotal = grossAmounts.reduce((s, v) => s + v, 0);
    const savings = Math.max(0, grossTotal - dealPrice);
    const discounts = allocateDealDiscount(savings, grossAmounts);

    selection.forEach((line, idx) => {
      const menuItem: any = menuItemById.get(line.menuItemId);
      const variant = line.variantId ? menuItem.variants.find((v: any) => v.id === line.variantId) : undefined;
      const unitPrice = grossAmounts[idx] / line.qty;
      revalidated.push({
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
      });
    });
  }

  return [...passThrough, ...revalidated];
}
