import { PrismaClient } from '@prisma/client';
import { WebsiteOrderType, WebsiteBookingType, WebsiteConfig, computeDeliveryFee } from './website.helpers.js';
import { getActiveOutlet, getOutletSettings } from './website.service.js';
import { readWebsiteConfig, isAcceptingOrders } from './website.helpers.js';
import { validateOrderStock } from '../order/order.controller.js';
import { parsePrices } from '../menu/publicMenu.js';
import { resolveChannelPrice } from '../deals/deal.pricing.js';
import { revalidateDealLines, withDealItemKeys, resolveOrderDiscount } from '../deals/deal.revalidate.js';
import { ApiError } from '../../utils/ApiError.js';

function round2(num: number): number {
  return Math.round(num * 100) / 100;
}

// `checkStock: false` is for reservation pre-orders: a booking days ahead must not be refused on
// today's stock (the staff Reservations picker skips the check for the same reason).
export async function priceWebsiteCart(prisma: PrismaClient, req: { outletId: string, orderType: WebsiteBookingType, items: any[], dealCode?: string | null, checkStock?: boolean }) {
  const { outletId, orderType, items, dealCode, checkStock = true } = req;

  const outlet = await getActiveOutlet(outletId);
  const settings = await getOutletSettings(outlet.id);
  const config = readWebsiteConfig(settings?.websiteConfig);
  const taxRate = settings?.taxRate != null ? Number(settings.taxRate) : 16;
  const acceptingOrders = isAcceptingOrders({ outletActive: outlet.isActive, onlineOrders: settings?.onlineOrders ?? true, config });

  // Check stock (throws if out of stock)
  if (checkStock !== false) {
    await validateOrderStock(prisma, outlet.id, items);
  }

  const itemsData: any[] = [];
  const linesOut: any[] = [];
  
  // separate plain vs deal lines
  const plainItems = items.filter(i => !i.dealId || !i.dealLineId);
  const dealItems = items.filter(i => i.dealId && i.dealLineId);

  // Process plain lines
  if (plainItems.length > 0) {
    const itemIds = plainItems.map(i => i.menuItemId).filter(Boolean) as string[];
    const dbItems = await prisma.foodMenuItem.findMany({
      where: { id: { in: itemIds }, available: true },
      include: { 
        variants: true, 
        modifiers: { include: { modifier: true } } 
      }
    });

    for (const reqItem of plainItems) {
      if (!reqItem.menuItemId) {
        throw ApiError.badRequest('Item missing menuItemId');
      }
      const dbItem = dbItems.find(i => i.id === reqItem.menuItemId);
      if (!dbItem) {
        throw ApiError.badRequest(`Item "${reqItem.name}" is no longer available`);
      }

      let pricingSource = dbItem;
      const variant = reqItem.variantId ? dbItem.variants.find(v => v.id === reqItem.variantId) : undefined;
      const computedName = `${dbItem.name}${variant ? ` (${variant.name})` : ''}`;

      if (reqItem.variantId) {
        if (!variant) {
          throw ApiError.badRequest(`Unknown variant for ${dbItem.name}`);
        }
        pricingSource = variant as any;
      }

      let unitPrice = resolveChannelPrice(parsePrices(pricingSource), orderType);
      
      const reqModIds = reqItem.modifierIds || [];
      const appliedModifiers: string[] = [];
      const dbModIds: any[] = [];

      for (const modId of reqModIds) {
        const link = dbItem.modifiers.find(m => m.modifierId === modId);
        if (!link || link.modifier.status !== 'active') {
          throw ApiError.badRequest(`Modifier is not available for ${dbItem.name}`);
        }
        unitPrice += Number(link.modifier.price);
        appliedModifiers.push(link.modifier.name);
        dbModIds.push({ modifierId: modId, qty: 1 });
      }

      const lineTotal = round2(unitPrice * reqItem.qty);
      const discount = 0;

      itemsData.push({
        menuItemId: reqItem.menuItemId,
        variantId: reqItem.variantId || null,
        name: computedName,
        price: unitPrice,
        qty: reqItem.qty,
        discount: 0,
        modifiers: appliedModifiers,
        modifierIds: dbModIds,
        cookingTime: dbItem.cookingTime ?? null,
        notes: reqItem.notes || null,
        dealId: null,
        dealName: null,
        dealLineId: null,
        dealItemKey: null
      });

      linesOut.push({
        name: computedName,
        qty: reqItem.qty,
        unitPrice,
        discount: 0,
        lineTotal,
        dealName: null
      });
    }
  }

  // Process deal lines
  if (dealItems.length > 0) {
    const dealIds = [...new Set(dealItems.map(i => i.dealId))];
    const dbDeals = await prisma.deal.findMany({
      where: { id: { in: dealIds as string[] } },
      select: { id: true, name: true, outletIds: true }
    });
    
    for (const d of dbDeals) {
      if (d.outletIds && d.outletIds.length > 0 && !d.outletIds.includes(outlet.id)) {
        throw ApiError.badRequest(`Deal "${d.name}" is not available at this branch`);
      }
    }
    
    const validatedDealItems = await revalidateDealLines(prisma, orderType, dealItems);
    
    for (const dItem of validatedDealItems) {
      const price = dItem.price ?? 0;
      const discount = dItem.discount ?? 0;
      const lineTotal = round2(price * dItem.qty - discount);
      
      itemsData.push({
        menuItemId: dItem.menuItemId,
        variantId: dItem.variantId,
        name: dItem.name,
        price,
        qty: dItem.qty,
        discount,
        modifiers: dItem.modifiers,
        modifierIds: dItem.modifierIds,
        cookingTime: dItem.cookingTime ?? null,
        notes: dItem.notes,
        dealId: dItem.dealId,
        dealName: dItem.dealName,
        dealLineId: dItem.dealLineId,
        dealItemKey: null
      });

      linesOut.push({
        name: dItem.name,
        qty: dItem.qty,
        unitPrice: price,
        discount,
        lineTotal,
        dealName: dItem.dealName
      });
    }
  }

  // apply dealItemKey
  const keyedItemsData = withDealItemKeys(itemsData);

  const hasLineDeal = keyedItemsData.some(i => i.dealId);
  if (hasLineDeal && dealCode) {
    throw ApiError.badRequest('Cannot apply a coupon — this order already has a deal applied');
  }

  const subtotal = round2(keyedItemsData.reduce((sum, item) => sum + (item.price * item.qty) - item.discount, 0));
  
  const orderDiscount = hasLineDeal ? null : await resolveOrderDiscount(prisma, { enteredCode: dealCode, outletId: outlet.id, orderType, subtotal });
  const discount = orderDiscount?.amount ?? 0;
  const taxable = round2(subtotal - discount);
  const tax = Math.round(taxable * taxRate / 100);
  const deliveryFee = computeDeliveryFee(orderType, config, taxable);
  const total = round2(taxable + tax + deliveryFee);
  const meetsMinOrder = orderType !== 'Delivery' || taxable >= config.minOrder;

  return {
    outlet,
    acceptingOrders,
    itemsData: keyedItemsData,
    lines: linesOut,
    subtotal,
    discount,
    appliedDeal: orderDiscount ? { dealId: orderDiscount.dealId, code: orderDiscount.code, dealName: orderDiscount.dealName } : null,
    taxRate,
    tax,
    deliveryFee,
    total,
    minOrder: config.minOrder,
    freeDeliveryAbove: config.freeDeliveryAbove,
    meetsMinOrder
  };
}
