/**
 * Order Controller
 * Phase 5: Orders, Order Items, Kitchens
 */

import type { Request, Response } from 'express';
import type { Prisma } from '@prisma/client';
import { prisma } from '../../config/database.js';
import { ApiResponse } from '../../utils/ApiResponse.js';
import { ApiError } from '../../utils/ApiError.js';
import { asyncHandler } from '../../utils/asyncHandler.js';
import { emitOrderEvent, emitTableEvent, emitReservationEvent, emitDeliveryEvent } from '../../socket.js';
import { fifoDrawdown } from '../stock/dough.helpers.js';
import { resolveOutletScope } from '../../middleware/outletScope.js';
import { mapReservation } from '../reservations/reservation.controller.js';
import { emitSelfOrderEventForOrder } from '../self-order/self-order.socket.js';
import { revalidateDealLines, resolveOrderDiscount } from '../deals/deal.revalidate.js';
import { round2 } from '../deals/deal.pricing.js';

// ── Enum conversion helpers ──

const TYPE_TO_PRISMA: Record<string, string> = {
  'Dine In': 'DINE_IN',
  'Take Away': 'TAKE_AWAY',
  'Delivery': 'DELIVERY',
  'Online': 'ONLINE',
  'Self Order': 'SELF_ORDER',
  'Foodpanda': 'FOODPANDA',
  'Walk-in': 'WALKIN',
  'DINE_IN': 'DINE_IN',
  'TAKE_AWAY': 'TAKE_AWAY',
  'DELIVERY': 'DELIVERY',
  'ONLINE': 'ONLINE',
  'SELF_ORDER': 'SELF_ORDER',
  'FOODPANDA': 'FOODPANDA',
  'WALKIN': 'WALKIN',
  'dine_in': 'DINE_IN',
  'take_away': 'TAKE_AWAY',
  'delivery': 'DELIVERY',
  'online': 'ONLINE',
  'self_order': 'SELF_ORDER',
  'foodpanda': 'FOODPANDA',
  'walkin': 'WALKIN',
};

const TYPE_TO_DISPLAY: Record<string, string> = {
  DINE_IN: 'Dine In',
  TAKE_AWAY: 'Take Away',
  DELIVERY: 'Delivery',
  ONLINE: 'Online',
  SELF_ORDER: 'Self Order',
  FOODPANDA: 'Foodpanda',
  WALKIN: 'Walk-in',
};

const STATUS_TO_PRISMA: Record<string, string> = {
  pending: 'PENDING',
  preparing: 'PREPARING',
  ready: 'READY',
  completed: 'COMPLETED',
  cancelled: 'CANCELLED',
  scheduled: 'SCHEDULED',
};

const STATUS_TO_DISPLAY: Record<string, string> = {
  PENDING: 'pending',
  PREPARING: 'preparing',
  READY: 'ready',
  COMPLETED: 'completed',
  CANCELLED: 'cancelled',
  SCHEDULED: 'scheduled',
};

/**
 * Helper to compute and update a table's status in the database based on active orders,
 * then emit socket push notifications to sync all terminals.
 */
export async function updateTableStatusForOrder(
  tx: any,
  outletId: string | null,
  tableNumber: number | null,
  staffUser?: { id: string; name: string | null; role: string | null } | null
): Promise<void> {
  if (!outletId || !tableNumber) return;

  const tableNumStr = String(tableNumber);
  const table = await tx.restaurantTable.findFirst({
    where: { number: tableNumStr, outletId },
  });
  if (!table) return;

  // Find if there are active dine-in or self-order orders for this table at this outlet
  const activeOrders = await tx.order.findMany({
    where: {
      outletId,
      tableNumber,
      type: { in: ['DINE_IN', 'SELF_ORDER'] },
      status: { in: ['PENDING', 'PREPARING', 'READY'] },
    },
  });

  const hasActiveOrders = activeOrders.length > 0;

  let newStatus = table.status;

  if (hasActiveOrders) {
    if (table.status !== 'bill-requested' && table.status !== 'occupied') {
      newStatus = 'occupied';
    }
  } else {
    // Keep current status (occupied/bill-requested) on order completion until explicitly cleared via End Sitting
  }

  let occupiedData: {
    occupiedById?: string | null;
    occupiedByName?: string | null;
    occupiedByRole?: string | null;
  } = {};
  if (newStatus === 'occupied') {
    occupiedData = {
      occupiedById: table.occupiedById || staffUser?.id || null,
      occupiedByName: table.occupiedByName || staffUser?.name || null,
      occupiedByRole: table.occupiedByRole || staffUser?.role || null,
    };
  } else if (newStatus === 'available') {
    occupiedData = {
      occupiedById: null,
      occupiedByName: null,
      occupiedByRole: null,
    };
  }

  const hasStatusChange = newStatus !== table.status;
  const hasOwnerChange =
    (occupiedData.occupiedById !== undefined && occupiedData.occupiedById !== table.occupiedById) ||
    (occupiedData.occupiedByName !== undefined && occupiedData.occupiedByName !== table.occupiedByName) ||
    (occupiedData.occupiedByRole !== undefined && occupiedData.occupiedByRole !== table.occupiedByRole);

  if (hasStatusChange || hasOwnerChange) {
    const updatedTable = await tx.restaurantTable.update({
      where: { id: table.id },
      data: {
        status: newStatus,
        ...occupiedData,
      },
    });
    emitTableEvent('table:updated', updatedTable, [outletId]);
  }
}

export async function checkPendingCancellation(orderId: string): Promise<boolean> {
  const count = await prisma.orderCancellationRequest.count({
    where: {
      orderId,
      status: 'pending',
    },
  });
  return count > 0;
}

export function mapOrderOut(order: any): any {
  if (!order) return order;
  const pendingCancelReq = Array.isArray(order.cancellationRequests) && order.cancellationRequests.length > 0
    ? order.cancellationRequests[0]
    : null;

  return {
    ...order,
    type: TYPE_TO_DISPLAY[order.type] ?? order.type,
    status: STATUS_TO_DISPLAY[order.status] ?? order.status,
    hasPendingCancellationRequest: Boolean(pendingCancelReq || order.hasPendingCancellationRequest),
    pendingCancellationRequest: pendingCancelReq ? {
      id: pendingCancelReq.id,
      status: pendingCancelReq.status,
      reason: pendingCancelReq.reason,
      createdAt: pendingCancelReq.createdAt,
    } : (order.pendingCancellationRequest || null),
    // Normalise Decimal fields to numbers so JSON serialises cleanly
    subtotal: order.subtotal != null ? Number(order.subtotal) : 0,
    discount: order.discount != null ? Number(order.discount) : 0,
    tax: order.tax != null ? Number(order.tax) : 0,
    total: order.total != null ? Number(order.total) : 0,
    advancePayment: order.advancePayment != null ? Number(order.advancePayment) : 0,
    items: (order.items ?? []).map((i: any) => ({
      ...i,
      price: i.price != null ? Number(i.price) : 0,
      discount: i.discount != null ? Number(i.discount) : 0,
      categoryName: i.menuItem?.category?.name ?? null,
    })),
    kitchenProgress: (order.kitchenProgress ?? []).map((p: any) => ({
      kitchenId: p.kitchenId,
      status: p.status,
      updatedAt: p.updatedAt,
    })),
  };
}

// ── Order Number Generation ──

export async function generateOrderNumber(): Promise<string> {
  const count = await prisma.order.count();
  let n = count + 1;
  while (n <= 99999) {
    const candidate = `ORD-${String(n).padStart(3, '0')}`;
    const exists = await prisma.order.findUnique({ where: { orderNumber: candidate } });
    if (!exists) return candidate;
    n++;
  }
  return `ORD-${Date.now().toString().slice(-6)}`;
}

// ============================================================
// ORDERS
// ============================================================

/** GET /api/orders */
export const getOrders = asyncHandler(async (req: Request, res: Response) => {
  const { search, status, type, date, tableNumber, orderSource, page = '1', limit = '50' } = req.query;
  const skip = (Number(page) - 1) * Number(limit);

  const where: any = {};
  // Outlet scope: Super Admin on "All" → no filter; otherwise restrict to the resolved outlet.
  const scope = resolveOutletScope(req);
  if (scope) where.outletId = scope;
  if (search) {
    where.OR = [
      { orderNumber: { contains: String(search), mode: 'insensitive' } },
      { customerName: { contains: String(search), mode: 'insensitive' } },
    ];
  }
  if (status) {
    const s = String(status);
    where.status = STATUS_TO_PRISMA[s] ?? s.toUpperCase();
  }
  if (type) {
    const t = String(type);
    where.type = TYPE_TO_PRISMA[t] ?? t.toUpperCase();
  }
  if (date) {
    const d = new Date(String(date));
    const next = new Date(d);
    next.setDate(next.getDate() + 1);
    where.date = { gte: d, lt: next };
  }
  if (tableNumber) where.tableNumber = Number(tableNumber);
  if (orderSource) where.orderSource = String(orderSource);

  const [orders, total] = await Promise.all([
    prisma.order.findMany({
      where,
      skip,
      take: Number(limit),
      orderBy: { createdAt: 'desc' },
      include: {
        items: {
          include: {
            menuItem: {
              select: { category: { select: { name: true } } },
            },
          },
        },
        cancellationRequests: {
          where: { status: 'pending' },
          select: { id: true, status: true, reason: true, createdAt: true },
        },
        kitchenProgress: true,
      },
    }),
    prisma.order.count({ where }),
  ]);

  res.json(ApiResponse.paginated(orders.map(mapOrderOut), Number(page), Number(limit), total));
});

/** GET /api/orders/:id */
export const getOrder = asyncHandler(async (req: Request, res: Response) => {
  const order = await prisma.order.findUnique({
    where: { id: req.params.id },
    include: {
      items: {
        include: {
          menuItem: {
            select: { category: { select: { name: true } } },
          },
        },
      },
      cancellationRequests: {
        where: { status: 'pending' },
        select: { id: true, status: true, reason: true, createdAt: true },
      },
      modifications: { orderBy: { timestamp: 'desc' } },
      kitchenProgress: true,
    },
  });
  if (!order) throw ApiError.notFound('Order not found');
  const scope = resolveOutletScope(req);
  if (scope && order.outletId !== scope) throw ApiError.notFound('Order not found');
  res.json(ApiResponse.success(mapOrderOut(order)));
});

/** POST /api/orders/validate-coupon — lets POS preview a Promo Code / Minimum
 *  Spend discount before the order is actually submitted. Uses the exact same
 *  resolveOrderDiscount call createOrder makes; never trusts a client-sent
 *  discount amount, only the subtotal the cart has built up so far. */
export const validateCoupon = asyncHandler(async (req: Request, res: Response) => {
  const { code, subtotal, orderType } = req.body;
  if (subtotal === undefined || isNaN(Number(subtotal))) throw ApiError.badRequest('subtotal is required');
  const scope = resolveOutletScope(req);
  const result = await resolveOrderDiscount(prisma, {
    enteredCode: code,
    outletId: scope,
    orderType,
    subtotal: round2(Number(subtotal)),
  });
  res.json(ApiResponse.success(result));
});

/** POST /api/orders */
export const createOrder = asyncHandler(async (req: Request, res: Response) => {
  const {
    customerName, phone, customerId, type, subtotal, discount, tax, total,
    paymentMethod, tableNumber, deliveryAddress, riderId, staffName,
    items, isFutureSale, scheduledDate, scheduledTime, futureNotes, advancePayment,
    isUrgent, customerType, orderSource, cashApproved, dealCode,
  } = req.body;

  if (!items?.length) throw ApiError.badRequest('Order must have at least one item');
  if (total === undefined || total === null) throw ApiError.badRequest('Total is required');

  const orderNumber = await generateOrderNumber();
  const prismaType = TYPE_TO_PRISMA[type] ?? 'WALKIN';
  const prismaStatus = isFutureSale ? 'SCHEDULED' : 'PENDING';

  // Outlet scope: stamp the order's outlet. Block only a Super Admin sitting on
  // "All Outlets" (scope === null) — they must pick a specific outlet to create.
  const scope = resolveOutletScope(req);
  if (scope === null && req.user?.role === 'Super Admin') {
    throw ApiError.badRequest('Select a specific outlet before creating');
  }

  const effectiveCashApproved = typeof cashApproved === 'boolean'
    ? cashApproved
    : (orderSource === 'waiter' ? false : true);

  await validateOrderStock(prisma, scope, items);
  const revalidatedItems = await revalidateDealLines(prisma, type, items);

  // Order-level discount (Promo Code / Minimum Spend) — the one part of this
  // order's money that IS re-derived server-side (see this file's known gap
  // note on item price/discount/total otherwise being trusted as sent).
  // Basis is the item total as this endpoint already has it (client-trusted
  // for plain lines, server-verified for deal lines above) — the same figure
  // that becomes order.subtotal, not a fully independent re-price.
  const itemsGross = revalidatedItems.reduce((s: number, i: any) => s + Number(i.price) * Number(i.qty), 0);
  const itemsDiscount = revalidatedItems.reduce((s: number, i: any) => s + Number(i.discount ?? 0), 0);
  const orderDiscount = await resolveOrderDiscount(prisma, {
    enteredCode: dealCode,
    outletId: scope,
    orderType: type,
    subtotal: round2(itemsGross - itemsDiscount),
  });

  // Only override the client-sent totals when a coupon/min-spend actually
  // applied — every other order keeps behaving exactly as it did. When one
  // does, it STACKS with whatever order-level discount the client already
  // sent (POS's own manual "extra discount" field) rather than replacing
  // it — dropping a staff-entered discount because a Minimum Spend deal
  // also happened to match would silently undercharge or overcharge the
  // customer relative to what the staff intended.
  const netItemsSubtotal = round2(itemsGross - itemsDiscount);
  const finalDiscount = orderDiscount ? round2((discount ?? 0) + orderDiscount.amount) : discount ?? 0;
  const finalTotal = orderDiscount ? round2(netItemsSubtotal - finalDiscount + Number(tax ?? 0)) : total;

  const order = await prisma.order.create({
    data: {
      orderNumber,
      outletId: scope,
      customerId: customerId || null,
      customerName: customerName || null,
      phone: phone || null,
      type: prismaType as any,
      subtotal: orderDiscount ? netItemsSubtotal : subtotal ?? 0,
      discount: finalDiscount,
      tax: tax ?? 0,
      total: finalTotal,
      appliedDealId: orderDiscount?.dealId ?? null,
      appliedDealCode: orderDiscount?.code ?? null,
      appliedDealName: orderDiscount?.dealName ?? null,
      status: prismaStatus as any,
      paymentMethod: paymentMethod || null,
      date: new Date(),
      time: new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }),
      staffId: req.user?.id || null,
      staffName: staffName || req.user?.name || null,
      tableNumber: tableNumber !== undefined && tableNumber !== null && !isNaN(Number(tableNumber)) ? Number(tableNumber) : null,
      deliveryAddress: deliveryAddress || null,
      riderId: riderId || null,
      isFutureSale: isFutureSale ?? false,
      scheduledDate: scheduledDate ? new Date(scheduledDate) : null,
      scheduledTime: scheduledTime || null,
      futureNotes: futureNotes || null,
      advancePayment: advancePayment ?? 0,
      isUrgent: isUrgent ?? false,
      customerType: customerType || null,
      orderSource: orderSource || 'pos',
      ...(cashApproved !== undefined ? { cashApproved: Boolean(cashApproved) } : { cashApproved: effectiveCashApproved }),
      items: {
        create: revalidatedItems.map((item: any) => ({
          menuItemId: item.menuItemId || null,
          variantId: item.variantId || null,
          name: item.name,
          price: item.price,
          qty: item.qty,
          discount: item.discount ?? 0,
          modifiers: item.modifiers ?? [],
          modifierIds: Array.isArray(item.modifierIds) ? item.modifierIds : [],
          cookingTime: item.cookingTime ?? null,
          notes: item.notes || null,
          dealId: item.dealId ?? null,
          dealName: item.dealName ?? null,
          dealLineId: item.dealLineId ?? null,
        })),
      },
    },
    include: {
      items: {
        include: {
          menuItem: {
            select: { category: { select: { name: true } } },
          },
        },
      },
    },
  });

  if (!isFutureSale) {
    // Resolve which active kitchens have at least one matching item, using the same
    // category-matching rule Kitchen Panel already applies today. If none match, there's
    // nothing to cook — skip the kitchen pipeline and mark the order ready immediately.
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
      await prisma.order.update({ where: { id: order.id }, data: { status: 'READY' as any } });
      order.status = 'READY' as any;
    }
  }

  const created = mapOrderOut(order);
  if (order.tableNumber && (order.type === 'DINE_IN' || order.type === 'SELF_ORDER')) {
    await updateTableStatusForOrder(prisma, order.outletId, order.tableNumber, req.user);
  }
  emitOrderEvent('order:created', created);
  res.status(201).json(ApiResponse.created(created, 'Order created'));
});

/** PUT /api/orders/:id */
export const updateOrder = asyncHandler(async (req: Request, res: Response) => {
  const { id } = req.params;
  const existing = await prisma.order.findUnique({ where: { id } });
  if (!existing) throw ApiError.notFound('Order not found');
  const scope = resolveOutletScope(req);
  if (scope && existing.outletId && existing.outletId !== scope) throw ApiError.notFound('Order not found');

  if (await checkPendingCancellation(id)) {
    throw ApiError.badRequest('Cannot modify order or approve payment while a cancellation request is pending approval');
  }

  const {
    customerName, phone, type, status, subtotal, discount, tax, total,
    paymentMethod, tableNumber, deliveryAddress, riderId, staffName,
    items, isUrgent, customerType, cashApproved, dealCode,
  } = req.body;

  const dataToUpdate: any = {};
  if (customerName !== undefined) dataToUpdate.customerName = customerName || null;
  if (phone !== undefined) dataToUpdate.phone = phone || null;
  if (type) dataToUpdate.type = (TYPE_TO_PRISMA[type] ?? type.toUpperCase()) as any;
  if (status) dataToUpdate.status = (STATUS_TO_PRISMA[status] ?? status.toUpperCase()) as any;
  if (subtotal !== undefined) dataToUpdate.subtotal = isNaN(Number(subtotal)) ? 0 : Number(subtotal);
  if (discount !== undefined) dataToUpdate.discount = isNaN(Number(discount)) ? 0 : Number(discount);
  if (tax !== undefined) dataToUpdate.tax = isNaN(Number(tax)) ? 0 : Number(tax);
  if (total !== undefined) dataToUpdate.total = isNaN(Number(total)) ? 0 : Number(total);
  if (paymentMethod !== undefined) {
    dataToUpdate.paymentMethod = paymentMethod || null;
    // Cash Hub attributes uncleared cash by order.staffId — re-stamp it to whoever
    // actually collects the payment (Pay Bill / Collect Payment), not whoever merely
    // created the order, the moment it transitions out of Pending/Unpaid. Riders are
    // unaffected (cash-settlement.service.ts already prefers order.riderId for them).
    const prevPm = (existing.paymentMethod || '').toLowerCase().trim();
    const wasUncollected = !prevPm || prevPm === 'pending' || prevPm === 'unpaid';
    const newPm = String(paymentMethod || '').toLowerCase().trim();
    const isNowCollected = !!newPm && newPm !== 'pending' && newPm !== 'unpaid';
    if (wasUncollected && isNowCollected && req.user) {
      dataToUpdate.staffId = req.user.id;
      if (staffName === undefined) dataToUpdate.staffName = req.user.name || existing.staffName;
    }
  }
  if (tableNumber !== undefined) dataToUpdate.tableNumber = tableNumber !== null && !isNaN(Number(tableNumber)) ? Number(tableNumber) : null;
  if (deliveryAddress !== undefined) dataToUpdate.deliveryAddress = deliveryAddress || null;
  if (riderId !== undefined) dataToUpdate.riderId = riderId ? String(riderId) : null;
  if (staffName !== undefined) dataToUpdate.staffName = staffName || null;
  if (isUrgent !== undefined) dataToUpdate.isUrgent = Boolean(isUrgent);
  if (customerType !== undefined) dataToUpdate.customerType = customerType || null;
  const order = await prisma.$transaction(async (tx) => {
    if (cashApproved !== undefined) {
      try {
        await tx.$executeRaw`UPDATE "orders" SET "cashApproved" = ${Boolean(cashApproved)}, "updatedAt" = NOW() WHERE "id" = ${id}`;
      } catch (e) {
        console.error('Failed to update cashApproved via raw SQL:', e);
      }
    }

    if (Array.isArray(items) && items.length > 0) {
      await tx.orderItem.deleteMany({ where: { orderId: id } });
      const revalidatedItems = await revalidateDealLines(tx, type ?? existing.type, items);

      // Only touch the order-level discount when the caller explicitly sent
      // `dealCode` (a string to apply, or null to clear) alongside the new
      // items — an items-only edit (e.g. adding a plain item) that says
      // nothing about the coupon must not silently drop an existing one.
      if (dealCode !== undefined) {
        const itemsGross = revalidatedItems.reduce((s: number, i: any) => s + Number(i.price) * Number(i.qty), 0);
        const itemsDiscount = revalidatedItems.reduce((s: number, i: any) => s + Number(i.discount ?? 0), 0);
        const netItemsSubtotal = round2(itemsGross - itemsDiscount);
        const orderDiscount = await resolveOrderDiscount(tx, {
          enteredCode: dealCode,
          outletId: scope ?? existing.outletId,
          orderType: type ?? existing.type,
          subtotal: netItemsSubtotal,
        });
        // Stacks with whatever manual order-level discount the client sent
        // (POS's own "extra discount" field) — never replaces it.
        const manualDiscount = Number(discount ?? 0);
        dataToUpdate.subtotal = netItemsSubtotal;
        dataToUpdate.discount = orderDiscount ? round2(manualDiscount + orderDiscount.amount) : round2(manualDiscount);
        dataToUpdate.total = round2(netItemsSubtotal - dataToUpdate.discount + Number(tax ?? existing.tax));
        dataToUpdate.appliedDealId = orderDiscount?.dealId ?? null;
        dataToUpdate.appliedDealCode = orderDiscount?.code ?? null;
        dataToUpdate.appliedDealName = orderDiscount?.dealName ?? null;
      }

      dataToUpdate.items = {
        create: revalidatedItems.map((item: any) => ({
          menuItemId: item.menuItemId || null,
          variantId: item.variantId || null,
          name: item.name,
          price: isNaN(Number(item.price)) ? 0 : Number(item.price),
          qty: isNaN(Number(item.qty)) ? 1 : Number(item.qty),
          discount: isNaN(Number(item.discount)) ? 0 : Number(item.discount),
          modifiers: Array.isArray(item.modifiers) ? item.modifiers : [],
          modifierIds: Array.isArray(item.modifierIds) ? item.modifierIds : [],
          cookingTime: item.cookingTime != null ? Number(item.cookingTime) : null,
          notes: item.notes || null,
          dealId: item.dealId ?? null,
          dealName: item.dealName ?? null,
          dealLineId: item.dealLineId ?? null,
        })),
      };
    }
    return tx.order.update({
      where: { id },
      data: dataToUpdate,
      include: {
        items: {
          include: {
            menuItem: {
              select: { category: { select: { name: true } } },
            },
          },
        },
      },
    });
  });

  const updatedOrder = mapOrderOut(order);
  if (existing.tableNumber && (existing.type === 'DINE_IN' || existing.type === 'SELF_ORDER')) {
    await updateTableStatusForOrder(prisma, existing.outletId, existing.tableNumber, req.user);
  }
  if (order.tableNumber && (order.type === 'DINE_IN' || order.type === 'SELF_ORDER')) {
    await updateTableStatusForOrder(prisma, order.outletId, order.tableNumber, req.user);
  }
  emitOrderEvent('order:updated', updatedOrder);
  res.json(ApiResponse.success(updatedOrder, 'Order updated'));
});

/**
 * Deducts ingredient/production-item stock the first time an order enters the kitchen
 * pipeline (PREPARING/READY/COMPLETED) — ingredients are physically consumed then, not
 * when the order is later marked complete. Idempotent: fires exactly once per order,
 * whichever of these three states it reaches first. Shared by both status-change
 * endpoints (whole-order and per-kitchen) so this delicate logic exists in one place.
 */
/**
 * Validates stock availability for ingredients and production items required by recipes in the order.
 * Throws ApiError.badRequest if any required ingredient or production item is out of stock.
 */
export async function validateOrderStock(
  tx: Prisma.TransactionClient | typeof prisma,
  outletId: string | null,
  items: { menuItemId?: string | null; variantId?: string | null; qty: number }[]
): Promise<void> {
  const menuItemIds = items
    .filter((i) => i.menuItemId && Number(i.qty) > 0)
    .map((i) => i.menuItemId as string);

  if (menuItemIds.length === 0) return;

  const recipes = await tx.foodRecipe.findMany({
    where: { menuItemId: { in: menuItemIds } },
    select: {
      menuItemId: true,
      variantId: true,
      ingredientId: true,
      productionItemId: true,
      qtyPerUnit: true,
      ingredient: { select: { id: true, name: true, unit: { select: { name: true, symbol: true } } } },
      productionItem: { select: { id: true, name: true, unit: true } },
    },
  });

  if (recipes.length === 0) return;

  let kitchenWarehouseId: string | null = null;
  if (outletId) {
    const kw = await tx.warehouse.findFirst({
      where: { outletId, type: 'KITCHEN' as never, isActive: true },
      select: { id: true },
    });
    kitchenWarehouseId = kw?.id ?? null;
  }

  const requiredIngredients: Record<string, { qty: number; name: string; unit: string }> = {};
  const requiredProdItems: Record<string, { qty: number; name: string; unit: string }> = {};

  for (const item of items) {
    if (!item.menuItemId || Number(item.qty) <= 0) continue;
    const itemRecipes = recipes.filter((r) => {
      if (r.menuItemId !== item.menuItemId) return false;
      if (item.variantId) return !r.variantId || r.variantId === item.variantId;
      return !r.variantId;
    });

    for (const r of itemRecipes) {
      const qtyNeeded = Number(r.qtyPerUnit) * Number(item.qty);
      if (r.ingredientId && r.ingredient) {
        const unitName = r.ingredient.unit?.symbol || r.ingredient.unit?.name || 'unit';
        if (!requiredIngredients[r.ingredientId]) {
          requiredIngredients[r.ingredientId] = { qty: 0, name: r.ingredient.name, unit: unitName };
        }
        requiredIngredients[r.ingredientId].qty += qtyNeeded;
      } else if (r.productionItemId && r.productionItem) {
        const unitName = r.productionItem.unit || 'unit';
        if (!requiredProdItems[r.productionItemId]) {
          requiredProdItems[r.productionItemId] = { qty: 0, name: r.productionItem.name, unit: unitName };
        }
        requiredProdItems[r.productionItemId].qty += qtyNeeded;
      }
    }
  }

  // Check ingredient stock
  for (const [ingredientId, reqData] of Object.entries(requiredIngredients)) {
    let availableStock = 0;
    if (kitchenWarehouseId) {
      const ws = await tx.warehouseStock.findUnique({
        where: { warehouseId_ingredientId: { warehouseId: kitchenWarehouseId, ingredientId } },
        select: { currentStock: true },
      });
      availableStock = Math.max(0, Number(ws?.currentStock ?? 0));
    } else {
      const ing = await tx.ingredient.findUnique({
        where: { id: ingredientId },
        select: { currentStock: true },
      });
      availableStock = Math.max(0, Number(ing?.currentStock ?? 0));
    }

    if (availableStock < reqData.qty) {
      throw ApiError.badRequest(
        `Insufficient stock for ingredient "${reqData.name}" (Required: ${reqData.qty.toFixed(2)} ${reqData.unit}, Available: ${availableStock.toFixed(2)} ${reqData.unit}). Order cannot be placed.`
      );
    }
  }

  // Check production item stock (e.g. Pizza Dough)
  if (kitchenWarehouseId) {
    for (const [productionItemId, reqData] of Object.entries(requiredProdItems)) {
      const pws = await tx.productionWarehouseStock.findFirst({
        where: { productionItemId, warehouseId: kitchenWarehouseId },
        select: { currentStock: true },
      });
      const availableStock = Math.max(0, Number(pws?.currentStock ?? 0));

      if (availableStock < reqData.qty) {
        throw ApiError.badRequest(
          `Insufficient stock for production item "${reqData.name}" (Required: ${reqData.qty.toFixed(2)} ${reqData.unit}, Available: ${availableStock.toFixed(2)} ${reqData.unit}). Order cannot be placed.`
        );
      }
    }
  }
}

export async function deductStockForConsumedStates(
  tx: Prisma.TransactionClient,
  existing: { status: string; outletId: string | null; orderNumber: string },
  items: { menuItemId: string | null; variantId: string | null; qty: number }[],
  newPrismaStatus: string,
  actingUserId: string | null | undefined,
): Promise<void> {
  const CONSUMED_STATES = ['PREPARING', 'READY', 'COMPLETED'];
  const alreadyConsumed = CONSUMED_STATES.includes(existing.status);
  const enteringConsumedState = CONSUMED_STATES.includes(newPrismaStatus);
  if (!(enteringConsumedState && !alreadyConsumed)) return;

  await validateOrderStock(tx, existing.outletId, items);

  const menuItemIds = items
    .filter((i) => i.menuItemId)
    .map((i) => i.menuItemId as string);

  if (menuItemIds.length === 0) return;

  const recipes = await tx.foodRecipe.findMany({
    where: { menuItemId: { in: menuItemIds } },
    select: {
      menuItemId: true,
      variantId: true,
      ingredientId: true,
      productionItemId: true,
      qtyPerUnit: true,
    },
  });

  // Group deductions: ingredientId → total qty to deduct
  // Group prodDeductions: productionItemId → total qty to deduct
  // If order item has a variantId, use variant-specific recipes; otherwise use item-level recipes
  const deductions: Record<string, number> = {};
  const prodDeductions: Record<string, number> = {};
  for (const item of items) {
    if (!item.menuItemId) continue;
    const itemRecipes = recipes.filter((r) => {
      if (r.menuItemId !== item.menuItemId) return false;
      if (item.variantId) return r.variantId === item.variantId;
      return !r.variantId; // item-level recipe (no variant)
    });
    for (const r of itemRecipes) {
      const qty = Number(r.qtyPerUnit) * item.qty;
      if (r.ingredientId) {
        deductions[r.ingredientId] = (deductions[r.ingredientId] || 0) + qty;
      } else if (r.productionItemId) {
        prodDeductions[r.productionItemId] = (prodDeductions[r.productionItemId] || 0) + qty;
      }
      // skip rows where both are null (shouldn't happen but be safe)
    }
  }

  // ── Also deduct modifier ingredient stock ──
  // Each ordered item carries modifierIds: [{ modifierId, qty }]
  // For modifier-backed ingredients, deduct qty * item.qty from stock
  const allModifierIds = new Set<string>();
  for (const item of items) {
    const mods = Array.isArray((item as any).modifierIds) ? (item as any).modifierIds : [];
    for (const m of mods) {
      if (m.modifierId) allModifierIds.add(m.modifierId);
    }
  }
  if (allModifierIds.size > 0) {
    const modifiers = await tx.modifier.findMany({
      where: { id: { in: [...allModifierIds] }, ingredientId: { not: null } },
      select: { id: true, ingredientId: true },
    });
    for (const item of items) {
      const mods = Array.isArray((item as any).modifierIds) ? (item as any).modifierIds : [];
      for (const m of mods) {
        const mod = modifiers.find(md => md.id === m.modifierId);
        if (!mod?.ingredientId) continue;
        const modQty = (Number(m.qty) || 1) * Number(item.qty);
        deductions[mod.ingredientId] = (deductions[mod.ingredientId] || 0) + modQty;
      }
    }
  }

  // Resolve kitchen warehouse for this order's outlet
  let kitchenWarehouseId: string | null = null;
  if (existing.outletId) {
    const kw = await tx.warehouse.findFirst({
      where: { outletId: existing.outletId, type: 'KITCHEN', isActive: true },
      select: { id: true },
    });
    kitchenWarehouseId = kw?.id ?? null;
  }

  const deductionEntries = Object.entries(deductions);

  // Pre-fetch lowStockLevel for all deducted ingredients in ONE query
  // (avoids an N+1 findUnique inside the loop on every sale).
  const lowStockById = new Map<string, number>();
  if (kitchenWarehouseId && deductionEntries.length > 0) {
    const ings = await tx.ingredient.findMany({
      where: { id: { in: deductionEntries.map(([id]) => id) } },
      select: { id: true, lowStockLevel: true },
    });
    for (const ing of ings) lowStockById.set(ing.id, Number(ing.lowStockLevel ?? 0));
  }

  // Apply per-ingredient stock decrements safely (clamped to Math.max(0, ...))
  for (const [ingredientId, qty] of deductionEntries) {
    // 1. Deduct global ingredient stock (backward compat)
    const ing = await tx.ingredient.findUnique({
      where: { id: ingredientId },
      select: { currentStock: true },
    });
    if (ing) {
      await tx.ingredient.update({
        where: { id: ingredientId },
        data: { currentStock: Math.max(0, Number(ing.currentStock) - qty) },
      });
    }

    // 2. Deduct kitchen warehouse stock (if linked)
    if (kitchenWarehouseId) {
      const ws = await tx.warehouseStock.findUnique({
        where: {
          warehouseId_ingredientId: {
            warehouseId: kitchenWarehouseId,
            ingredientId,
          },
        },
        select: { currentStock: true },
      });
      const newWsStock = Math.max(0, (ws ? Number(ws.currentStock) : 0) - qty);
      await tx.warehouseStock.upsert({
        where: {
          warehouseId_ingredientId: {
            warehouseId: kitchenWarehouseId,
            ingredientId,
          },
        },
        update: { currentStock: newWsStock },
        create: {
          warehouseId: kitchenWarehouseId,
          ingredientId,
          currentStock: 0,
          lowStockLevel: lowStockById.get(ingredientId) ?? 0,
        },
      });
    }
  }

  // For short-life ingredients (dough), keep their StockBatch.remainingQty in sync
  // by drawing the sold qty down FIFO (oldest batch first). Sale is never blocked.
  if (deductionEntries.length > 0) {
    const shortLife = await tx.ingredient.findMany({
      where: { id: { in: deductionEntries.map(([id]) => id) }, shelfLifeHours: { not: null } },
      select: { id: true },
    });
    const shortLifeIds = new Set(shortLife.map((i) => i.id));
    for (const [ingredientId, qty] of deductionEntries) {
      if (!shortLifeIds.has(ingredientId)) continue;
      const batches = await tx.stockBatch.findMany({
        where: { ingredientId, remainingQty: { gt: 0 }, ...(kitchenWarehouseId ? { warehouseId: kitchenWarehouseId } : {}) },
        select: { id: true, remainingQty: true },
        orderBy: { createdAt: 'asc' },
      });
      const draws = fifoDrawdown(
        batches.map((b) => ({ id: b.id, remainingQty: Number(b.remainingQty) })),
        qty
      );
      for (const d of draws) {
        await tx.stockBatch.update({ where: { id: d.id }, data: { remainingQty: d.newRemaining } });
      }
    }
  }

  // 3. Log all consumption adjustments in ONE batched insert
  if (deductionEntries.length > 0) {
    await tx.stockAdjustment.createMany({
      data: deductionEntries.map(([ingredientId, qty]) => ({
        ingredientId,
        type: 'deduct',
        quantity: qty,
        reason: `POS consumption — Order ${existing.orderNumber}`,
        adjustedById: actingUserId ?? null,
        warehouseId: kitchenWarehouseId ?? undefined,
        date: new Date(),
      })),
    });
  }

  // 4. Production item FIFO drawdown
  const prodEntries = Object.entries(prodDeductions);
  if (prodEntries.length > 0 && kitchenWarehouseId) {
    for (const [productionItemId, qty] of prodEntries) {
      const batches = await tx.productionBatch.findMany({
        where: {
          productionItemId,
          warehouseId: kitchenWarehouseId,
          remainingQty: { gt: 0 },
        },
        select: { id: true, remainingQty: true },
        orderBy: { createdAt: 'asc' },
      });
      const draws = fifoDrawdown(
        batches.map((b) => ({ id: b.id, remainingQty: Number(b.remainingQty) })),
        qty
      );
      for (const d of draws) {
        await tx.productionBatch.update({
          where: { id: d.id },
          data: { remainingQty: d.newRemaining },
        });
      }
      const pws = await tx.productionWarehouseStock.findFirst({
        where: { productionItemId, warehouseId: kitchenWarehouseId },
        select: { id: true, currentStock: true },
      });
      if (pws) {
        await tx.productionWarehouseStock.update({
          where: { id: pws.id },
          data: { currentStock: Math.max(0, Number(pws.currentStock) - qty) },
        });
      }
    }
  }
}

/**
 * Runs everything that must happen right after an order's status changes, outside the
 * write transaction: mapping the response, completing linked reservations (only when
 * the new status is COMPLETED), syncing dine-in/self-order table status, pushing a
 * live update to a self-order customer's device, and emitting the order:updated socket
 * event. Shared by both status-change endpoints so this side-effect list can't drift
 * between them. Returns the mapped order object for the caller's own response.
 */
export async function runOrderStatusPostEffects(
  prismaClient: typeof prisma,
  existing: { id: string; outletId: string | null; type: string; tableNumber: number | null },
  order: any,
  newPrismaStatus: string,
  req: Request,
): Promise<any> {
  const statusUpdated = mapOrderOut(order);

  if (newPrismaStatus === 'COMPLETED') {
    const updatedReservations = await prismaClient.reservation.findMany({
      where: {
        OR: [
          { orderId: existing.id },
          ...(existing.tableNumber ? [{ tableNumber: String(existing.tableNumber) }] : [])
        ]
      }
    });
    for (const resItem of updatedReservations) {
      emitReservationEvent('reservation:updated', mapReservation(resItem), [resItem.outletId]);
    }
  }

  if (order.tableNumber && (order.type === 'DINE_IN' || order.type === 'SELF_ORDER')) {
    await updateTableStatusForOrder(prismaClient, order.outletId, order.tableNumber, req.user);
  }
  if (order.type === 'SELF_ORDER') {
    await emitSelfOrderEventForOrder(order, 'order:updated', {
      orderId: order.id,
      status: order.status === 'CANCELLED' ? 'cancelled' : 'confirmed',
      accepted: !!order.acceptedById,
      rejectionReason: order.rejectionReason ?? undefined,
      paid: order.status === 'COMPLETED',
    });
  }
  emitOrderEvent('order:updated', statusUpdated);
  return statusUpdated;
}

/** PUT /api/orders/:id/status */
export const updateOrderStatus = asyncHandler(async (req: Request, res: Response) => {
  const { id } = req.params;
  const { status } = req.body;
  if (!status) throw ApiError.badRequest('Status is required');

  const existing = await prisma.order.findUnique({
    where: { id },
    include: { items: true },
  });
  if (!existing) throw ApiError.notFound('Order not found');
  const scope = resolveOutletScope(req);
  if (scope && existing.outletId !== scope) throw ApiError.notFound('Order not found');

  if (await checkPendingCancellation(id)) {
    throw ApiError.badRequest('Cannot change order status while a cancellation request is pending approval');
  }

  const prismaStatus = STATUS_TO_PRISMA[status] ?? status.toUpperCase();

  const order = await prisma.$transaction(async (tx) => {
    const updated = await tx.order.update({
      where: { id },
      data: { status: prismaStatus as any },
      include: {
        items: {
          include: {
            menuItem: {
              select: { category: { select: { name: true } } },
            },
          },
        },
        kitchenProgress: true,
      },
    });

    await deductStockForConsumedStates(tx, existing, updated.items, prismaStatus, req.user?.id);

    if (prismaStatus === 'READY' || prismaStatus === 'COMPLETED') {
      await tx.orderKitchenProgress.updateMany({
        where: { orderId: id },
        data: { status: 'ready' },
      });
    }

    if (prismaStatus === 'COMPLETED') {
      await tx.reservation.updateMany({
        where: {
          OR: [
            { orderId: id },
            ...(existing.tableNumber ? [{ tableNumber: String(existing.tableNumber), status: 'seated' }] : [])
          ],
          status: { not: 'completed' }
        },
        data: { status: 'completed' }
      });
    }

    return updated;
  }, { timeout: 30000 });

  const statusUpdated = await runOrderStatusPostEffects(prisma, existing, order, prismaStatus, req);
  res.json(ApiResponse.success(statusUpdated, 'Order status updated'));
});

/** PUT /api/orders/:id/kitchen-status — one kitchen updates its own progress on an order */
export const updateOrderKitchenStatus = asyncHandler(async (req: Request, res: Response) => {
  const { id } = req.params;
  const { kitchenId, status } = req.body;
  if (!kitchenId) throw ApiError.badRequest('kitchenId is required');
  if (!status || !['preparing', 'ready'].includes(status)) {
    throw ApiError.badRequest('status must be one of: preparing, ready');
  }

  const existing = await prisma.order.findUnique({
    where: { id },
    include: { items: true, kitchenProgress: true },
  });
  if (!existing) throw ApiError.notFound('Order not found');
  const scope = resolveOutletScope(req);
  if (scope && existing.outletId !== scope) throw ApiError.notFound('Order not found');

  if (await checkPendingCancellation(id)) {
    throw ApiError.badRequest('Cannot change order status while a cancellation request is pending approval');
  }

  let progress = existing.kitchenProgress.find((p) => p.kitchenId === kitchenId);
  if (!progress) {
    // Self-healing: if an order was created before progress rows were populated
    // (e.g. historic self-orders), dynamically create the missing progress row.
    const kitchenObj = await prisma.kitchen.findUnique({ where: { id: kitchenId } });
    if (!kitchenObj) throw ApiError.notFound('Kitchen not found');

    progress = await prisma.orderKitchenProgress.create({
      data: {
        orderId: id,
        kitchenId,
        status: 'pending',
      },
    });
    existing.kitchenProgress.push(progress);
  }

  const activeKitchens = await prisma.kitchen.findMany({ where: { status: 'active' } });

  // Map each kitchen's status after this update:
  const getKitchenStatusAfter = (kId: string): string => {
    if (kId === kitchenId) return status;
    const p = existing.kitchenProgress.find((row) => row.kitchenId === kId);
    return p ? p.status : 'pending';
  };

  // An order is READY automatically when all items' assigned kitchens are 'ready'
  let allReadyAfter = status === 'ready';
  if (allReadyAfter && existing.items.length > 0) {
    for (const item of existing.items as any[]) {
      const catName = item.categoryName || item.menuItem?.category?.name;
      if (!catName) continue;
      const assigned = activeKitchens.filter(
        (k) => Array.isArray(k.assignedCategories) && k.assignedCategories.includes(catName)
      );
      if (assigned.length > 0) {
        const itemReady = assigned.every((k) => getKitchenStatusAfter(k.id) === 'ready');
        if (!itemReady) {
          allReadyAfter = false;
          break;
        }
      }
    }
  }

  const anyStartedAfter = status === 'preparing' || status === 'ready'
    || existing.kitchenProgress.some((p) => p.status === 'preparing' || p.status === 'ready');

  let newPrismaStatus = existing.status;
  if (allReadyAfter) newPrismaStatus = 'READY' as any;
  else if (anyStartedAfter && (existing.status === 'PENDING' || existing.status === 'SCHEDULED')) newPrismaStatus = 'PREPARING' as any;

  const order = await prisma.$transaction(async (tx) => {
    await tx.orderKitchenProgress.update({
      where: { id: progress.id },
      data: { status },
    });

    const needsOrderUpdate = newPrismaStatus !== existing.status;
    const updated = needsOrderUpdate
      ? await tx.order.update({
          where: { id },
          data: { status: newPrismaStatus as any },
          include: {
            items: { include: { menuItem: { select: { category: { select: { name: true } } } } } },
            kitchenProgress: true,
          },
        })
      : await tx.order.findUniqueOrThrow({
          where: { id },
          include: {
            items: { include: { menuItem: { select: { category: { select: { name: true } } } } } },
            kitchenProgress: true,
          },
        });

    await deductStockForConsumedStates(tx, existing, updated.items, newPrismaStatus as string, req.user?.id);

    return updated;
  }, { timeout: 30000 });

  const statusUpdated = await runOrderStatusPostEffects(prisma, existing, order, newPrismaStatus as string, req);
  res.json(ApiResponse.success(statusUpdated, 'Kitchen status updated'));
});

/** POST /api/orders/:id/accept-self-order — a waiter claims a pending self-order.
 *  Does NOT change status (stays PENDING); only stamps who accepted it. That status
 *  stays PENDING deliberately: an accepted self-order should behave exactly like any
 *  other freshly-placed pending order from here on, going through the kitchen's own
 *  Accept Order step (pending -> preparing) like everything else — not skip it. */
export const acceptSelfOrder = asyncHandler(async (req: Request, res: Response) => {
  const { id } = req.params;

  const existing = await prisma.order.findUnique({ where: { id } });
  if (!existing) throw ApiError.notFound('Order not found');
  const scope = resolveOutletScope(req);
  if (scope && existing.outletId !== scope) throw ApiError.notFound('Order not found');
  if (existing.type !== 'SELF_ORDER') throw ApiError.badRequest('Not a self-order');

  const result = await prisma.order.updateMany({
    where: { id, acceptedById: null },
    data: {
      acceptedById: req.user?.id || null,
      acceptedByName: req.user?.name || null,
      staffId: req.user?.id || null,
      staffName: req.user?.name || null,
    },
  });

  if (result.count === 0) {
    const latest = await prisma.order.findUnique({ where: { id } });
    throw ApiError.conflict(`Already accepted by ${latest?.acceptedByName ?? 'another staff member'}`);
  }

  const updated = await prisma.order.findUnique({
    where: { id },
    include: {
      items: { include: { menuItem: { select: { category: { select: { name: true } } } } } },
      kitchenProgress: true,
    },
  });

  // Occupy the table only now that a waiter has actually verified this order is
  // real — a still-pending, unaccepted self-order never touches table status.
  if (updated?.tableNumber) {
    await updateTableStatusForOrder(prisma, updated.outletId, updated.tableNumber, req.user);
    // Stamp currentOrderId in the same "timestamp:guestCount" format the manual
    // waiter-initiated flows already use, so WaiterPanel's getGuestsCount() shows
    // the customer's real guest count instead of falling back to table capacity.
    if (updated.outletId) {
      await prisma.restaurantTable.updateMany({
        where: { outletId: updated.outletId, number: String(updated.tableNumber) },
        data: { currentOrderId: `${Date.now()}:${updated.guestCount ?? 1}` },
      });
    }
  }

  if (updated) {
    await emitSelfOrderEventForOrder(updated, 'order:updated', {
      orderId: updated.id,
      status: 'confirmed',
      accepted: true,
      paid: updated.status === 'COMPLETED',
    });
  }

  const mapped = mapOrderOut(updated);
  emitOrderEvent('order:updated', mapped);
  res.json(ApiResponse.success(mapped, 'Order accepted'));
});

/** POST /api/orders/:id/reject-self-order — declines a pending self-order. Reuses
 *  the ordinary CANCELLED status (no new enum value); rejectionReason is optional. */
export const rejectSelfOrder = asyncHandler(async (req: Request, res: Response) => {
  const { id } = req.params;
  const { reason } = req.body;

  const existing = await prisma.order.findUnique({ where: { id } });
  if (!existing) throw ApiError.notFound('Order not found');
  const scope = resolveOutletScope(req);
  if (scope && existing.outletId !== scope) throw ApiError.notFound('Order not found');
  if (existing.type !== 'SELF_ORDER') throw ApiError.badRequest('Not a self-order');
  if (existing.status !== 'PENDING' || existing.acceptedById) {
    throw ApiError.badRequest('This order can no longer be declined');
  }

  const updated = await prisma.order.update({
    where: { id },
    data: { status: 'CANCELLED', rejectionReason: reason || null },
    include: {
      items: { include: { menuItem: { select: { category: { select: { name: true } } } } } },
    },
  });

  await emitSelfOrderEventForOrder(updated, 'order:updated', {
    orderId: updated.id,
    status: 'cancelled',
    accepted: false,
    rejectionReason: updated.rejectionReason ?? undefined,
    paid: false,
  });

  const mapped = mapOrderOut(updated);
  emitOrderEvent('order:updated', mapped);
  res.json(ApiResponse.success(mapped, 'Order declined'));
});

/**
 * Validates that itemIds/newSubtotal/newTax/newTotal form a coherent cancel request
 * against the order's current active items. Shared by cancellation-request creation
 * (validate up front) and approval (re-validate — order state may have moved on).
 */
export function validateCancellationTargets(
  activeItems: { id: string }[],
  itemIds: string[] | undefined,
  newSubtotal: unknown,
  newTax: unknown,
  newTotal: unknown,
): boolean {
  const isItemCancel = Array.isArray(itemIds) && itemIds.length > 0 && itemIds.length < activeItems.length;
  if (isItemCancel) {
    const validIds = new Set(activeItems.map((i) => i.id));
    for (const tid of itemIds as string[]) {
      if (!validIds.has(tid)) throw ApiError.badRequest('One or more items do not belong to this order');
    }
    if (newSubtotal == null || newTax == null || newTotal == null) {
      throw ApiError.badRequest('Recalculated totals are required for a partial cancellation');
    }
    if (
      typeof newSubtotal !== 'number' || typeof newTax !== 'number' || typeof newTotal !== 'number'
      || newTotal < 0
    ) {
      throw ApiError.badRequest('Recalculated totals must be non-negative numbers');
    }
  }
  return isItemCancel;
}

/**
 * Executes the actual cancellation mutation (item or full order) inside an existing
 * transaction: marks items/order cancelled, recomputes totals, writes waste records for
 * already-consumed stock, and logs an OrderModificationLog entry. Extracted from the
 * former direct PIN-gated `POST /orders/:id/cancel` endpoint (removed — cancellation is
 * now request→approval only) so the `cancellation-requests` module's approval handler
 * can reuse the exact same mutation logic.
 */
export async function executeCancellation(
  tx: Prisma.TransactionClient,
  params: {
    existing: { id: string; outletId: string | null; status: string; items: any[]; tableNumber?: number | null; type?: string };
    itemIds?: string[];
    reason: string;
    refundAmount: number;
    refundMethod: string;
    newSubtotal?: number;
    newTax?: number;
    newTotal?: number;
    authorizedById: string;
    actingUserName?: string | null;
    penaltyAmount?: number;
    responsibleUserName?: string | null;
  },
): Promise<any> {
  const {
    existing, itemIds, reason, refundAmount, refundMethod,
    newSubtotal, newTax, newTotal, authorizedById, actingUserName,
    penaltyAmount, responsibleUserName,
  } = params;
  const id = existing.id;

  const activeItems = existing.items.filter((i: any) => i.status !== 'cancelled');
  const isItemCancel = validateCancellationTargets(activeItems, itemIds, newSubtotal, newTax, newTotal);

  if (isItemCancel) {
    await tx.orderItem.updateMany({
      where: { id: { in: itemIds } },
      data: { status: 'cancelled' },
    });
    await tx.order.update({
      where: { id },
      data: { subtotal: newSubtotal, tax: newTax, total: newTotal },
    });
  } else {
    await tx.orderItem.updateMany({
      where: { id: { in: activeItems.map((i) => i.id) } },
      data: { status: 'cancelled' },
    });
    await tx.order.update({ where: { id }, data: { status: 'CANCELLED' } });

    // Handle active delivery assignments for this cancelled order
    const activeAssignments = await tx.deliveryAssignment.findMany({
      where: { orderId: id, status: { in: ['pending', 'accepted', 'dispatched'] } },
      include: { rider: true },
    });

    for (const assignment of activeAssignments) {
      await tx.deliveryAssignment.update({
        where: { id: assignment.id },
        data: {
          status: 'returned',
          notes: reason ? `Order Cancelled: ${reason}` : 'Order Cancelled',
        },
      });

      if (assignment.rider) {
        const currentRemaining = Math.max(0, (assignment.rider.activeDeliveries || 1) - 1);
        await tx.deliveryRider.update({
          where: { id: assignment.rider.id },
          data: {
            activeDeliveries: { decrement: 1 },
            isAvailable: assignment.rider.status !== 'off_duty' && assignment.rider.status !== 'offline' && currentRemaining < 5,
            status: currentRemaining === 0 ? 'available' : 'on_delivery',
          },
        });
      }

      emitDeliveryEvent('delivery:status_updated', {
        assignmentId: assignment.id,
        orderId: id,
        riderId: assignment.riderId,
        status: 'returned',
        outletId: existing.outletId,
      }, [existing.outletId]);
    }
  }

    // Waste accounting — only if this order had already entered the kitchen pipeline
    // (Task 3: stock for its active items was already deducted at PREPARING/READY).
    // A still-PENDING order never had stock deducted, so there is nothing to record.
    if (existing.status !== 'PENDING') {
      // Use activeItems (defined above), not existing.items — a prior partial cancel on
      // this order may have already cancelled and waste-recorded some items, and
      // re-including them here would double-count their waste.
      const targetItems = isItemCancel
        ? activeItems.filter((i) => (itemIds as string[]).includes(i.id))
        : activeItems;
      const menuItemIds = targetItems.filter((i) => i.menuItemId).map((i) => i.menuItemId as string);

      if (menuItemIds.length > 0) {
        // Find kitchen warehouse id to retrieve latest production batch unit costs
        let kitchenWarehouseId: string | null = null;
        if (existing.outletId) {
          const kw = await tx.warehouse.findFirst({
            where: { outletId: existing.outletId, type: 'KITCHEN', isActive: true },
            select: { id: true },
          });
          kitchenWarehouseId = kw?.id ?? null;
        }

        // Fetch all recipes for these menu items
        const recipes = await tx.foodRecipe.findMany({
          where: { menuItemId: { in: menuItemIds } },
          select: { menuItemId: true, variantId: true, ingredientId: true, productionItemId: true, qtyPerUnit: true },
        });

        // Get unique ingredient IDs and fetch their purchase prices, then override
        // with the more-accurate latest stock-batch unit cost (set when goods are received).
        const ingredientIds = [...new Set(recipes.map((r) => r.ingredientId).filter((id): id is string => id !== null))];
        let priceById = new Map<string, number>();
        if (ingredientIds.length > 0) {
          const ingredientList = await tx.ingredient.findMany({
            where: { id: { in: ingredientIds } },
            select: { id: true, purchasePrice: true },
          });
          priceById = new Map(ingredientList.map((i) => [i.id, Number(i.purchasePrice ?? 0)]));

          // Override with actual stock-batch unit costs where available — these reflect
          // the real price paid, whereas purchasePrice may not always be kept up to date.
          for (const ingId of ingredientIds) {
            const latestBatch = await tx.stockBatch.findFirst({
              where: { ingredientId: ingId, unitCost: { not: null } },
              orderBy: { createdAt: 'desc' },
              select: { unitCost: true },
            });
            if (latestBatch?.unitCost != null && Number(latestBatch.unitCost) > 0) {
              priceById.set(ingId, Number(latestBatch.unitCost));
            }
          }
        }

        // Get unique production item IDs and fetch their unit costs from latest batch
        const productionItemIds = [...new Set(recipes.map((r) => r.productionItemId).filter((id): id is string => id !== null))];
        const prodPriceById = new Map<string, number>();
        if (productionItemIds.length > 0 && kitchenWarehouseId) {
          for (const pid of productionItemIds) {
            const latestBatch = await tx.productionBatch.findFirst({
              where: { productionItemId: pid, warehouseId: kitchenWarehouseId, unitCost: { not: null } },
              orderBy: { createdAt: 'desc' },
              select: { unitCost: true },
            });
            prodPriceById.set(pid, latestBatch?.unitCost != null ? Number(latestBatch.unitCost) : 0);
          }
        }

        // Calculate recipe cost for each menu item in targetItems
        let totalOrderWasteCost = 0;
        const itemCosts: Record<string, number> = {};

        for (const item of targetItems) {
          if (!item.menuItemId) continue;
          const itemRecipes = recipes.filter((r) => {
            if (r.menuItemId !== item.menuItemId) return false;
            if (item.variantId) return r.variantId === item.variantId;
            return !r.variantId;
          });

          let unitPrepCost = 0;
          for (const r of itemRecipes) {
            if (r.ingredientId) {
              const price = priceById.get(r.ingredientId) || 0;
              unitPrepCost += Number(r.qtyPerUnit) * price;
            } else if (r.productionItemId) {
              const price = prodPriceById.get(r.productionItemId) || 0;
              unitPrepCost += Number(r.qtyPerUnit) * price;
            }
          }

          // Fallback: If recipe cost is 0 (or recipe not configured), use the item's selling price
          if (unitPrepCost === 0 && item.price != null) {
            unitPrepCost = Number(item.price);
          }

          const totalItemCost = unitPrepCost * item.qty;
          itemCosts[item.id] = totalItemCost;
          totalOrderWasteCost += totalItemCost;
        }

        // Penalty calculations
        const totalPenalty = penaltyAmount || 0;
        const menuItemTargetCount = targetItems.filter((i) => i.menuItemId).length;

        for (const item of targetItems) {
          if (!item.menuItemId) continue;
          const rawItemCost = itemCosts[item.id] || 0;

          // Proportional penalty allocation.
          // If recipe cost is known: allocate proportionally by cost share.
          // If recipe cost is 0 (recipe not defined / no prices): split equally — we still
          // know the penalty amount and must record it accurately.
          let allocatedPenalty = 0;
          if (totalPenalty > 0) {
            if (totalOrderWasteCost > 0) {
              allocatedPenalty = (rawItemCost / totalOrderWasteCost) * totalPenalty;
            } else if (menuItemTargetCount > 0) {
              allocatedPenalty = totalPenalty / menuItemTargetCount;
            }
          }

          const netCost = Math.max(0, rawItemCost - allocatedPenalty);

          let reasonNote = 'Order cancelled after preparation';
          if (totalPenalty > 0 && responsibleUserName) {
            if (rawItemCost > 0) {
              // Recipe cost is known — show full breakdown
              if (allocatedPenalty >= rawItemCost) {
                reasonNote = `Order cancelled. Full cost penalty of Rs. ${allocatedPenalty.toFixed(0)} charged to ${responsibleUserName}. Total cost: Rs. ${rawItemCost.toFixed(0)}. Net loss: Rs. 0.`;
              } else {
                reasonNote = `Order cancelled. Partial penalty of Rs. ${allocatedPenalty.toFixed(0)} charged to ${responsibleUserName}. Total cost: Rs. ${rawItemCost.toFixed(0)}. Net loss: Rs. ${netCost.toFixed(0)}.`;
              }
            } else {
              // Recipe/prices not configured — still record penalty charged
              reasonNote = `Order cancelled. Penalty of Rs. ${allocatedPenalty.toFixed(0)} charged to ${responsibleUserName}. (Recipe cost not available.)`;
            }
          }

          await tx.wasteRecord.create({
            data: {
              itemName: item.name || 'Unknown Item',
              quantity: item.qty,
              unit: 'portion',
              reason: reasonNote,
              cost: netCost,
              recordedBy: actingUserName ?? null,
              outletId: existing.outletId,
              warehouseId: kitchenWarehouseId,
              orderId: id,
            },
          });
        }
      }
    }

  await tx.orderModificationLog.create({
    data: {
      orderId: id,
      action: isItemCancel ? 'item_cancelled' : 'order_cancelled',
      detail: reason,
      staff: actingUserName ?? null,
      refundAmount,
      refundMethod,
      authorizedById,
    },
  });

  const cancelled = await tx.order.findUnique({
    where: { id },
    include: {
      items: {
        include: { menuItem: { select: { category: { select: { name: true } } } } },
      },
    },
  });

  if (existing.tableNumber && (existing.type === 'DINE_IN' || existing.type === 'SELF_ORDER')) {
    await updateTableStatusForOrder(tx, existing.outletId, existing.tableNumber, { id: authorizedById, name: actingUserName || null, role: null });
  }

  return cancelled;
}

/** DELETE /api/orders/:id */
export const deleteOrder = asyncHandler(async (req: Request, res: Response) => {
  const existing = await prisma.order.findUnique({ where: { id: req.params.id } });
  if (!existing) throw ApiError.notFound('Order not found');
  const scope = resolveOutletScope(req);
  if (scope && existing.outletId !== scope) throw ApiError.notFound('Order not found');
  await prisma.order.delete({ where: { id: req.params.id } });
  if (existing.tableNumber && (existing.type === 'DINE_IN' || existing.type === 'SELF_ORDER')) {
    await updateTableStatusForOrder(prisma, existing.outletId, existing.tableNumber, req.user);
  }
  emitOrderEvent('order:deleted', { id: req.params.id });
  res.json(ApiResponse.success(null, 'Order deleted'));
});

// ============================================================
// KITCHENS
// ============================================================

/** GET /api/kitchens */
export const getKitchens = asyncHandler(async (_req: Request, res: Response) => {
  const kitchens = await prisma.kitchen.findMany({ orderBy: { name: 'asc' } });
  res.json(ApiResponse.success(kitchens));
});

/** POST /api/kitchens */
export const createKitchen = asyncHandler(async (req: Request, res: Response) => {
  const { name, assignedCategories, status } = req.body;
  if (!name?.trim()) throw ApiError.badRequest('Kitchen name is required');

  const kitchen = await prisma.kitchen.create({
    data: {
      name: name.trim(),
      assignedCategories: assignedCategories ?? [],
      status: status ?? 'active',
    },
  });
  res.status(201).json(ApiResponse.created(kitchen, 'Kitchen created'));
});

/** PUT /api/kitchens/:id */
export const updateKitchen = asyncHandler(async (req: Request, res: Response) => {
  const { id } = req.params;
  const { name, assignedCategories, status } = req.body;

  const existing = await prisma.kitchen.findUnique({ where: { id } });
  if (!existing) throw ApiError.notFound('Kitchen not found');

  const kitchen = await prisma.kitchen.update({
    where: { id },
    data: {
      ...(name && { name: name.trim() }),
      ...(assignedCategories !== undefined && { assignedCategories }),
      ...(status && { status }),
    },
  });
  res.json(ApiResponse.success(kitchen, 'Kitchen updated'));
});

/** DELETE /api/kitchens/:id */
export const deleteKitchen = asyncHandler(async (req: Request, res: Response) => {
  const existing = await prisma.kitchen.findUnique({ where: { id: req.params.id } });
  if (!existing) throw ApiError.notFound('Kitchen not found');
  await prisma.kitchen.delete({ where: { id: req.params.id } });
  res.json(ApiResponse.success(null, 'Kitchen deleted'));
});
