/**
 * Self-Order Controller
 *
 * Public (unauthenticated) endpoints for the QR-code customer ordering flow. A
 * customer scanning a table's QR has no JWT — every handler here re-derives
 * outletId from the scanned table row, and never trusts anything the client
 * claims about outlet/scope.
 */

import type { Request, Response } from 'express';
import { prisma } from '../../config/database.js';
import { ApiResponse } from '../../utils/ApiResponse.js';
import { ApiError } from '../../utils/ApiError.js';
import { asyncHandler } from '../../utils/asyncHandler.js';
import { emitOrderEvent } from '../../socket.js';
import { generateOrderNumber, mapOrderOut } from '../order/order.controller.js';
import { emitSelfOrderTableEvent, clearSelfOrderTableState } from './self-order.socket.js';
import { resolveOutletScope } from '../../middleware/outletScope.js';
import { revalidateDealLines, resolveOrderDiscount } from '../deals/deal.revalidate.js';
import { isDealCurrentlyValid, mapDealOutPublic, round2 } from '../deals/deal.pricing.js';

/** GET /api/self-order/table/:tableId */
export const getTableForSelfOrder = asyncHandler(async (req: Request, res: Response) => {
  const table = await prisma.restaurantTable.findUnique({
    where: { id: req.params.tableId },
    include: { outlet: { select: { id: true, name: true } } },
  });
  if (!table) throw ApiError.notFound('Table not found');

  res.json(ApiResponse.success({
    tableId: table.id,
    tableNumber: table.number,
    floor: table.floor,
    capacity: table.capacity,
    outletId: table.outletId,
    outletName: table.outlet?.name ?? null,
  }));
});

/** GET /api/self-order/customer-lookup?phone=<digits> — UX-only lookup for the
 *  entry-gate's "keep this name?" prompt. Never a security/trust boundary —
 *  createSelfOrder independently re-derives the same lookup at order-creation
 *  time and does not trust anything about how the client got here.
 *
 *  Public + unauthenticated by design (a customer scanning a QR has no JWT),
 *  so this is rate-limited (customerLookupLimiter in self-order.routes.ts) and
 *  requires a near-complete phone match: a low-digit `contains` substring
 *  match would let unlimited anonymous callers confirm whether an arbitrary
 *  partial phone number belongs to a known customer and get back their real
 *  name — a PII disclosure risk. 11 digits is this project's own established
 *  complete-phone-number convention (see SelfOrder.tsx's entry-gate
 *  validation, `cleanPhone.length === 11`); requiring an exact match at that
 *  length (not a substring) closes the substring-oracle angle too. */
export const lookupCustomerByPhone = asyncHandler(async (req: Request, res: Response) => {
  const cleanPhone = String(req.query.phone || '').replace(/\D/g, '');
  if (cleanPhone.length < 10) {
    res.json(ApiResponse.success({ exists: false }));
    return;
  }
  const formattedPhone = cleanPhone.length === 11 ? `${cleanPhone.slice(0, 4)}-${cleanPhone.slice(4)}` : cleanPhone;
  const customer = await prisma.customer.findFirst({
    where: {
      OR: [
        { phone: { equals: cleanPhone } },
        { phone: { equals: formattedPhone } },
      ],
    },
  });
  res.json(ApiResponse.success(customer ? { exists: true, name: customer.name } : { exists: false }));
});

/** GET /api/self-order/menu — the menu catalog is global (no outletId column on
 *  FoodMenuItem/FoodCategory), so every outlet sees the same active/available menu.
 *  Deliberately returns only customer-facing fields — never the staff-facing
 *  normalizeMenuItem() shape, which spreads dineInPrice/takeAwayPrice/deliveryPrice/
 *  foodpandaPrice (internal per-channel pricing) with zero auth on this route. */
export const getSelfOrderMenu = asyncHandler(async (_req: Request, res: Response) => {
  const categories = await prisma.foodCategory.findMany({
    where: { status: 'active' },
    orderBy: [{ displayOrder: 'asc' }, { name: 'asc' }],
    select: { id: true, name: true, displayOrder: true, status: true },
  });

  const items = await prisma.foodMenuItem.findMany({
    where: { available: true },
    orderBy: [{ category: { displayOrder: 'asc' } }, { name: 'asc' }],
    include: {
      category: { select: { id: true, name: true } },
      variants: { orderBy: { displayOrder: 'asc' } },
      modifiers: { include: { modifier: true } },
    },
  });

  const publicItems = items.map((item) => ({
    id: item.id,
    name: item.name,
    price: Number(item.price),
    image: item.image ?? null,
    category: item.category ? { id: item.category.id, name: item.category.name } : null,
    variants: item.variants.map((v) => ({ id: v.id, name: v.name, price: Number(v.price) })),
    modifiers: item.modifiers
      .filter((mm) => mm.modifier.status === 'active')
      .map((mm) => ({ id: mm.modifier.id, name: mm.modifier.name, price: Number(mm.modifier.price) })),
  }));

  res.json(ApiResponse.success({ categories, items: publicItems }));
});

/** GET /api/self-order/deals?tableId=<id> — public, unauthenticated deal
 *  browsing for the QR menu. Outlet scope is derived from the table (never
 *  a client-declared outletId, per this module's own rule) — pass ?tableId=
 *  to see that table's outlet-restricted deals in addition to chain-wide
 *  ones; omit it to see only chain-wide (outletIds empty) deals. Only
 *  currently-valid deals are returned — a self-order customer should never
 *  see a deal that isn't actually sellable right now. */
export const getSelfOrderDeals = asyncHandler(async (req: Request, res: Response) => {
  const tableId = typeof req.query.tableId === 'string' ? req.query.tableId : undefined;
  let outletId: string | null = null;
  if (tableId) {
    const table = await prisma.restaurantTable.findUnique({ where: { id: tableId } });
    outletId = table?.outletId ?? null;
  }

  const deals = await prisma.deal.findMany({
    where: {
      status: { not: 'archived' },
      isActive: true,
      OR: [{ outletIds: { isEmpty: true } }, ...(outletId ? [{ outletIds: { has: outletId } }] : [])],
    },
    include: {
      components: { orderBy: { displayOrder: 'asc' as const } },
      optionGroups: {
        orderBy: { displayOrder: 'asc' as const },
        include: { options: { orderBy: { displayOrder: 'asc' as const } } },
      },
    },
    orderBy: { createdAt: 'desc' },
  });

  const liveDeals = deals.filter((d) => isDealCurrentlyValid(d as any).valid);
  res.json(ApiResponse.success(liveDeals.map(mapDealOutPublic)));
});

/** POST /api/self-order/orders */
/** POST /api/self-order/validate-coupon — lets the cart preview a Promo Code /
 *  Minimum Spend discount before the order is submitted. Public/unauthenticated
 *  like the rest of this module; outlet is re-derived from the scanned table,
 *  never trusted from the client. */
export const validateSelfOrderCoupon = asyncHandler(async (req: Request, res: Response) => {
  const { tableId, code, subtotal } = req.body;
  if (!tableId) throw ApiError.badRequest('tableId is required');
  if (subtotal === undefined || isNaN(Number(subtotal))) throw ApiError.badRequest('subtotal is required');

  const table = await prisma.restaurantTable.findUnique({ where: { id: tableId } });
  if (!table) throw ApiError.notFound('Table not found');

  const result = await resolveOrderDiscount(prisma, {
    enteredCode: code,
    outletId: table.outletId,
    orderType: 'Dine In',
    subtotal: round2(Number(subtotal)),
  });
  res.json(ApiResponse.success(result));
});

export const createSelfOrder = asyncHandler(async (req: Request, res: Response) => {
  const {
    tableId, customerName, customerPhone, guestCount,
    items, specialInstructions, dealCode,
  } = req.body;

  if (!tableId) throw ApiError.badRequest('tableId is required');
  if (!customerName?.trim()) throw ApiError.badRequest('Customer name is required');
  if (!customerPhone?.trim()) throw ApiError.badRequest('Phone number is required');
  if (!guestCount || Number(guestCount) < 1) throw ApiError.badRequest('Guest count is required');
  if (!items?.length) throw ApiError.badRequest('Order must have at least one item');

  const table = await prisma.restaurantTable.findUnique({ where: { id: tableId } });
  if (!table) throw ApiError.notFound('Table not found');
  if (!table.outletId) throw ApiError.badRequest('This table is not assigned to an outlet');

  // Deal-tagged items (dealId + dealLineId set) are never priced from the
  // client-sent item — they're re-derived below via revalidateDealLines from
  // the live Deal + menu records, same as order.controller.ts's createOrder.
  const plainItems = items.filter((i: any) => !(i.dealId && i.dealLineId));
  const dealItems = items.filter((i: any) => i.dealId && i.dealLineId);

  // Validate every plain item against the live, available menu — never trust client-sent
  // item existence, price, or modifier selection. Fetch full records so price can
  // be recomputed server-side.
  const menuItemIds: string[] = plainItems.map((i: any) => i.menuItemId).filter(Boolean);
  const availableMenuItems = menuItemIds.length
    ? await prisma.foodMenuItem.findMany({
        where: { id: { in: menuItemIds }, available: true },
        include: { variants: true, modifiers: { include: { modifier: true } } },
      })
    : [];
  const menuItemById = new Map(availableMenuItems.map((m) => [m.id, m]));

  const settings = (await prisma.settings.findFirst({ where: { outletId: table.outletId } }))
    ?? (await prisma.settings.findFirst());
  const taxRatePercent = settings ? Number(settings.taxRate) : 16;

  let computedSubtotal = 0;
  const itemsData = plainItems.map((item: any) => {
    const menuItem = item.menuItemId ? menuItemById.get(item.menuItemId) : undefined;
    if (item.menuItemId && !menuItem) {
      throw ApiError.badRequest(`Item "${item.name || 'unknown'}" is no longer available`);
    }

    let unitPrice = menuItem ? Number(menuItem.price) : 0;
    let variantId: string | null = null;
    if (item.variantId && menuItem) {
      const variant = menuItem.variants.find((v) => v.id === item.variantId);
      if (!variant) throw ApiError.badRequest(`Selected size for "${menuItem.name}" is no longer available`);
      unitPrice = Number(variant.price);
      variantId = variant.id;
    }

    const modifierNames: string[] = [];
    if (Array.isArray(item.modifierIds) && menuItem) {
      for (const modId of item.modifierIds) {
        const link = menuItem.modifiers.find((mm) => mm.modifier.id === modId);
        if (!link) throw ApiError.badRequest(`Selected extra for "${menuItem.name}" is no longer available`);
        unitPrice += Number(link.modifier.price);
        modifierNames.push(link.modifier.name);
      }
    }

    const qty = Math.max(1, Math.trunc(Number(item.qty) || 1));
    computedSubtotal += unitPrice * qty;

    return {
      menuItemId: item.menuItemId || null,
      variantId,
      name: item.name,
      price: unitPrice,
      qty,
      discount: 0,
      modifiers: modifierNames,
      notes: item.notes || null,
      dealId: null as string | null,
      dealName: null as string | null,
      dealLineId: null as string | null,
    };
  });

  if (dealItems.length > 0) {
    // Self-order is dine-in only (a customer scanning a table's QR), so deal
    // channel pricing always resolves against dineInPrice.
    const revalidatedDealItems = await revalidateDealLines(prisma, 'Dine In', dealItems);
    for (const item of revalidatedDealItems) {
      const qty = Math.max(1, Math.trunc(Number(item.qty) || 1));
      const discount = Number(item.discount ?? 0);
      computedSubtotal += Number(item.price) * qty - discount;
      itemsData.push({
        menuItemId: item.menuItemId ?? null,
        variantId: item.variantId ?? null,
        name: item.name ?? '',
        price: Number(item.price),
        qty,
        discount,
        modifiers: [],
        notes: null,
        dealId: item.dealId ?? null,
        dealName: item.dealName ?? null,
        dealLineId: item.dealLineId ?? null,
      });
    }
  }

  // Order has no order-level notes field; the cart's single special-instructions
  // textarea is carried on the first line item only (existing schema only supports
  // per-item notes — see OrderItem.notes usage in order.controller.ts).
  if (itemsData.length > 0 && specialInstructions && !itemsData[0].notes) {
    itemsData[0].notes = specialInstructions;
  }

  // Order-level discount (Promo Code / Minimum Spend) — fully server-derived,
  // same as everything else in this handler: self-order is public/
  // unauthenticated, so a client-sent discount amount is never trusted.
  const orderDiscount = await resolveOrderDiscount(prisma, {
    enteredCode: dealCode,
    outletId: table.outletId,
    orderType: 'Dine In', // self-order is always dine-in
    subtotal: round2(computedSubtotal),
  });
  const orderDiscountAmount = orderDiscount?.amount ?? 0;
  const taxableSubtotal = round2(computedSubtotal - orderDiscountAmount);

  const computedTax = Math.round(taxableSubtotal * (taxRatePercent / 100));
  const computedTotal = taxableSubtotal + computedTax;

  // Find-or-link a Customer record by phone. The entry gate's name-conflict
  // dialog (SelfOrder.tsx) already asks the customer to confirm which name to
  // use BEFORE this request is ever sent — so by the time createSelfOrder
  // runs, customerName is the customer's confirmed choice. Update the matched
  // customer's name to it, mirroring the admin createCustomer endpoint's own
  // on-match behavior (this reverses an earlier "never overwrite" rule for
  // this flow specifically, per explicit product decision — see the design
  // doc dated 2026-07-31 for the rationale).
  //
  // The match itself MUST use the same exact-equals + 10-digit-minimum rule
  // as lookupCustomerByPhone above (not a `contains` substring match): this
  // endpoint is public/unauthenticated, and a looser matcher would let an
  // arbitrary caller rename any customer whose stored phone merely contains a
  // short digit sequence they send — a phone short enough to skip the
  // confirmation dialog entirely (dialog requires 10+ digits) could still
  // reach this write path unconfirmed. Keeping both matchers identical closes
  // that gap: whatever the dialog would (or wouldn't) have shown the customer
  // is exactly what this lookup will (or won't) match and rename.
  const cleanCustomerPhone = customerPhone.trim().replace(/\D/g, '');
  const formattedPhone = cleanCustomerPhone.length === 11 ? `${cleanCustomerPhone.slice(0, 4)}-${cleanCustomerPhone.slice(4)}` : customerPhone.trim();
  let customer = cleanCustomerPhone.length >= 10
    ? await prisma.customer.findFirst({
        where: {
          OR: [
            { phone: { equals: cleanCustomerPhone } },
            { phone: { equals: formattedPhone } },
          ],
        },
      })
    : null;
  if (customer) {
    if (customer.name !== customerName.trim() || customer.phone !== formattedPhone) {
      customer = await prisma.customer.update({
        where: { id: customer.id },
        data: { name: customerName.trim(), phone: formattedPhone },
      });
    }
  } else {
    customer = await prisma.customer.create({
      data: { name: customerName.trim(), phone: formattedPhone, customerType: 'walk-in' },
    });
  }

  const orderNumber = await generateOrderNumber();

  const order = await prisma.order.create({
    data: {
      orderNumber,
      outletId: table.outletId,
      customerName: customerName.trim(),
      phone: customerPhone.trim(),
      customerId: customer.id,
      type: 'SELF_ORDER',
      subtotal: computedSubtotal,
      discount: orderDiscountAmount,
      tax: computedTax,
      total: computedTotal,
      appliedDealId: orderDiscount?.dealId ?? null,
      appliedDealCode: orderDiscount?.code ?? null,
      appliedDealName: orderDiscount?.dealName ?? null,
      status: 'PENDING',
      paymentMethod: 'Pending',
      date: new Date(),
      time: new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }),
      staffName: 'Self Order',
      tableNumber: !isNaN(Number(table.number)) ? Number(table.number) : null,
      orderSource: 'self-order',
      guestCount: Number(guestCount),
      items: { create: itemsData },
    },
    include: {
      items: { include: { menuItem: { select: { category: { select: { name: true } } } } } },
    },
  });

  // Deliberately does NOT occupy the table yet — this order is unverified until a
  // waiter accepts it. Table occupancy is triggered from acceptSelfOrder instead.

  // Mirror the same kitchen-matching logic that createOrder runs so that kitchen
  // staff can accept this order via PUT /orders/:id/kitchen-status. Without these
  // rows, that endpoint always throws 400 "This kitchen has no items on this order".
  const activeKitchens = await prisma.kitchen.findMany({ where: { status: 'active' } });
  const matchedKitchenIds = new Set<string>();
  for (const item of order.items as any[]) {
    const categoryName = item.menuItem?.category?.name;
    if (!categoryName) continue;
    for (const kitch of activeKitchens) {
      if (Array.isArray(kitch.assignedCategories) && kitch.assignedCategories.includes(categoryName)) {
        matchedKitchenIds.add(kitch.id);
      }
    }
  }
  if (matchedKitchenIds.size > 0) {
    await prisma.orderKitchenProgress.createMany({
      data: Array.from(matchedKitchenIds).map((kitchenId) => ({
        orderId: order.id,
        kitchenId,
        status: 'pending',
      })),
    });
  } else {
    // No kitchen assigned to any item in this order — mark it ready immediately
    // (e.g., a drinks-only order on an outlet with no beverage kitchen).
    await prisma.order.update({ where: { id: order.id }, data: { status: 'READY' as any } });
  }

  emitOrderEvent('order:created', mapOrderOut(order));
  emitSelfOrderTableEvent(table.id, 'order:updated', {
    orderId: order.id,
    status: 'pending',
    accepted: false,
    paid: false,
  });
  res.status(201).json(ApiResponse.created({ orderId: order.id }, 'Order placed'));
});

/** GET /api/self-order/orders/:id/status — minimal poll target; order ids are
 *  unguessable UUIDs, so exposing status by id needs no separate secret. */
export const getSelfOrderStatus = asyncHandler(async (req: Request, res: Response) => {
  const order = await prisma.order.findUnique({ where: { id: req.params.id } });
  if (!order) throw ApiError.notFound('Order not found');

  const status = order.status === 'CANCELLED' ? 'cancelled'
    : order.status === 'PENDING' ? 'pending'
    : 'confirmed';

  res.json(ApiResponse.success({
    orderId: order.id,
    status,
    accepted: !!order.acceptedById,
    rejectionReason: order.rejectionReason ?? undefined,
    paid: order.status === 'COMPLETED',
  }));
});

/** GET /api/self-order/table/:tableId/active-orders — lets a device that just
 *  became host (via take-over promotion, or a fresh join to a table another
 *  device already ordered at) learn about orders already placed at this
 *  table this sitting. A promoted device is a genuinely separate device with
 *  its own empty localStorage for this table — without this, its local
 *  `orders` list stays empty even though the table has real active orders.
 *  Scoped to self-order-created rows only (never a POS-placed order — those
 *  aren't this customer-facing screen's concern) and to orders not yet
 *  finalized (cancelled/completed): there's no "sitting id" boundary marker
 *  anywhere in this schema, so a broader fetch would risk pulling in a truly
 *  stale, already-settled order from an earlier, unrelated sitting at the
 *  same table (the same gap already accepted/documented for persisted
 *  sessions in general — this endpoint deliberately doesn't try to solve
 *  that separately, just to not make it worse). */
export const getActiveOrdersForTable = asyncHandler(async (req: Request, res: Response) => {
  const table = await prisma.restaurantTable.findUnique({ where: { id: req.params.tableId } });
  if (!table) throw ApiError.notFound('Table not found');

  const tableNumber = !isNaN(Number(table.number)) ? Number(table.number) : null;
  if (tableNumber === null) {
    res.json(ApiResponse.success([]));
    return;
  }

  const orders = await prisma.order.findMany({
    where: {
      outletId: table.outletId,
      tableNumber,
      orderSource: 'self-order',
      status: { notIn: ['CANCELLED', 'COMPLETED'] },
    },
    include: { items: true },
    orderBy: { createdAt: 'asc' },
  });

  res.json(ApiResponse.success(orders.map((order) => ({
    orderId: order.id,
    items: order.items.map((item) => ({
      id: item.id,
      menuItemId: item.menuItemId,
      variantId: item.variantId,
      name: item.name,
      price: Number(item.price),
      qty: item.qty,
      modifiers: item.modifiers,
    })),
    status: {
      orderId: order.id,
      status: order.status === 'CANCELLED' ? 'cancelled' : order.status === 'PENDING' ? 'pending' : 'confirmed',
      accepted: !!order.acceptedById,
      rejectionReason: order.rejectionReason ?? undefined,
      paid: order.status === 'COMPLETED',
    },
  }))));
});

/** POST /api/self-order/table/:tableId/end-session — staff-authenticated
 *  exception in this otherwise-public module. Called by WaiterPanel's End
 *  Sitting action to notify the table's live self-order session (if any) that
 *  it has ended, and to clear its in-memory host state so the next customer
 *  to scan this table's QR gets a genuinely fresh session. Pure notification —
 *  performs no data mutation itself; the actual table/order state changes
 *  already happen in WaiterPanel's existing End Sitting flow before this is called. */
export const notifySelfOrderSessionEnded = asyncHandler(async (req: Request, res: Response) => {
  const { tableId } = req.params;
  const table = await prisma.restaurantTable.findUnique({ where: { id: tableId } });
  if (!table) throw ApiError.notFound('Table not found');
  const scope = resolveOutletScope(req);
  if (scope && table.outletId !== scope) throw ApiError.notFound('Table not found');

  emitSelfOrderTableEvent(tableId, 'session:ended', {});
  clearSelfOrderTableState(tableId);
  res.json(ApiResponse.success(null, 'Session-ended notification sent'));
});
