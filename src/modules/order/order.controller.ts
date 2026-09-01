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
import { revalidateDealLines, resolveOrderDiscount, withDealItemKeys } from '../deals/deal.revalidate.js';
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
    // Per-dish status for deal redemptions — a sibling to kitchenProgress
    // above, which still covers every non-deal item as one shared ticket.
    kitchenDealProgress: (order.kitchenDealProgress ?? []).map((p: any) => ({
      kitchenId: p.kitchenId,
      dealItemKey: p.dealItemKey,
      status: p.status,
      updatedAt: p.updatedAt,
    })),
  };
}

// ── Order Number Generation ──

export async function generateOrderNumber(): Promise<string> {
  // Highest existing order number instead of a full COUNT(*) on every create
  // (the count scans the whole table and only grows). The dedup loop below
  // still guards against gaps and collisions.
  const latest = await prisma.order.findFirst({
    orderBy: { createdAt: 'desc' },
    select: { orderNumber: true },
  });
  const parsed = latest ? parseInt(latest.orderNumber.replace(/\D/g, ''), 10) : 0;
  // If the newest order carries the exhaustion fallback (`ORD-<6-digit timestamp>`)
  // its number is meaningless as a sequence position — fall back to COUNT(*) so we
  // don't cascade into the timestamp fallback on every subsequent order.
  const lastN = Number.isFinite(parsed) && parsed < 99999 ? parsed : await prisma.order.count();
  let n = lastN + 1;
  while (n <= 99999) {
    const candidate = `ORD-${String(n).padStart(3, '0')}`;
    const exists = await prisma.order.findUnique({ where: { orderNumber: candidate } });
    if (!exists) return candidate;
    n++;
  }
  return `ORD-${Date.now().toString().slice(-6)}`;
}

/** Reports whether ANY of an order's items matches an active kitchen's
 *  assignedCategories, so the caller can skip the kitchen pipeline entirely
 *  (mark the order READY immediately) when nothing needs cooking. Creates no
 *  progress rows: every dish — deal or plain — gets its own
 *  OrderKitchenDealProgress ticket created lazily the first time a kitchen
 *  actually touches it (updateOrderKitchenStatus), the same self-healing
 *  pattern deal dishes always used and the shared ticket used for historic
 *  orders. `db` is kept in the signature for call-site symmetry / future use. */
export async function seedKitchenProgress(
  db: Prisma.TransactionClient | typeof prisma,
  _orderId: string,
  items: { dealId?: string | null; menuItem?: { category?: { name?: string | null } | null } | null }[],
): Promise<boolean> {
  const activeKitchens = await (db as typeof prisma).kitchen.findMany({ where: { status: 'active' } });

  for (const item of items) {
    const categoryName = item.menuItem?.category?.name;
    if (!categoryName) continue;
    for (const kitch of activeKitchens) {
      if (Array.isArray(kitch.assignedCategories) && kitch.assignedCategories.includes(categoryName)) {
        return true;
      }
    }
  }

  return false;
}

/**
 * Recomputes what an order's whole status should be from its *persisted* kitchen
 * progress rows plus the current set of active kitchens. Used when the kitchen
 * roster changes (a kitchen deleted / deactivated / re-categorised) so an order
 * stuck in PREPARING only because a kitchen it was waiting on is gone can be
 * re-evaluated.
 *
 * An item counts as ready when — among the active kitchens assigned to its
 * category — at least one has a 'ready' progress row for it and none has a row
 * that isn't 'ready'. A kitchen with no row for that item never took it (another
 * kitchen sharing the category did) and doesn't hold the order back.
 */
export function computeDerivedOrderStatus(
  order: {
    items: { dealId?: string | null; dealItemKey?: string | null; menuItem?: { category?: { name?: string | null } | null } | null }[];
    kitchenProgress: { kitchenId: string; status: string }[];
    kitchenDealProgress: { kitchenId: string; dealItemKey: string; status: string }[];
  },
  activeKitchens: { id: string; assignedCategories: string[] }[],
): 'PENDING' | 'PREPARING' | 'READY' {
  const anyStarted = [...order.kitchenProgress, ...order.kitchenDealProgress]
    .some((r) => r.status === 'preparing' || r.status === 'ready');

  let hasKitchenRoutedItem = false;
  let allItemsReady = true;

  for (const item of order.items) {
    const catName = item.menuItem?.category?.name;
    if (!catName) continue;
    const assigned = activeKitchens.filter(
      (k) => Array.isArray(k.assignedCategories) && k.assignedCategories.includes(catName),
    );
    if (assigned.length === 0) continue;
    hasKitchenRoutedItem = true;

    // Every item now carries its own per-dish key (deal or plain); only rows
    // written before that fall through to the legacy shared per-kitchen ticket.
    const rows = item.dealItemKey
      ? assigned
          .map((k) => order.kitchenDealProgress.find((p) => p.kitchenId === k.id && p.dealItemKey === item.dealItemKey))
          .filter((p): p is { kitchenId: string; dealItemKey: string; status: string } => !!p)
      : assigned
          .map((k) => order.kitchenProgress.find((p) => p.kitchenId === k.id))
          .filter((p): p is { kitchenId: string; status: string } => !!p);

    if (!(rows.length > 0 && rows.every((r) => r.status === 'ready'))) {
      allItemsReady = false;
      break;
    }
  }

  if (hasKitchenRoutedItem && allItemsReady) return 'READY';
  if (anyStarted) return 'PREPARING';
  return 'PENDING';
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
        kitchenDealProgress: true,
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
      kitchenDealProgress: true,
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

  // These three have no dependency on each other — run them together rather
  // than as three serial round-trips to Neon. resolveOrderDiscount stays
  // after: it needs the revalidated item totals. (If both the stock check and
  // deal revalidation would fail, the client now sees whichever rejects first
  // — both are 400s, so the outcome is unchanged.)
  const [orderNumber, , revalidatedRaw] = await Promise.all([
    generateOrderNumber(),
    validateOrderStock(prisma, scope, items),
    revalidateDealLines(prisma, type, items),
  ]);
  const revalidatedItems = withDealItemKeys(revalidatedRaw);

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
          dealItemKey: item.dealItemKey ?? null,
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
    const hasKitchenWork = await seedKitchenProgress(prisma, order.id, order.items as any[]);
    if (!hasKitchenWork) {
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
      const revalidatedItems = withDealItemKeys(await revalidateDealLines(tx, type ?? existing.type, items));

      // Whenever the items change, the order-level discount has to be
      // re-derived from the NEW contents — an edit can push the order over (or
      // under) a Minimum Spend floor, and a percentage coupon is a function of
      // the subtotal. Skipping this (it used to be gated on the caller sending
      // `dealCode`) let a plain items-only edit from POS overwrite
      // subtotal/discount/total with client figures that know nothing about
      // the discount, silently dropping the money while leaving appliedDealId
      // and appliedDealName pointing at a deal the total no longer reflects.
      //
      // The code to re-check is whatever the caller explicitly sent, or — when
      // it says nothing about the coupon — whatever the order already had, so
      // an unrelated edit never loses a coupon the customer already used.
      const explicitCode = dealCode !== undefined;
      const codeToApply = explicitCode ? dealCode : existing.appliedDealCode;
      const itemsGross = revalidatedItems.reduce((s: number, i: any) => s + Number(i.price) * Number(i.qty), 0);
      const itemsDiscount = revalidatedItems.reduce((s: number, i: any) => s + Number(i.discount ?? 0), 0);
      const netItemsSubtotal = round2(itemsGross - itemsDiscount);

      let orderDiscount: Awaited<ReturnType<typeof resolveOrderDiscount>> = null;
      try {
        orderDiscount = await resolveOrderDiscount(tx, {
          enteredCode: codeToApply,
          outletId: scope ?? existing.outletId,
          orderType: type ?? existing.type,
          subtotal: netItemsSubtotal,
        });
      } catch (err) {
        // A code the caller just typed that doesn't apply is a real error the
        // staff member needs to see. A carried-over one that stopped
        // qualifying (the edit dropped the order below its minimum spend) is
        // not — the coupon simply comes off, and the edit goes through.
        if (explicitCode) throw err;
        orderDiscount = null;
      }

      // Stacks with whatever manual order-level discount the client sent
      // (POS's own "extra discount" field) — never replaces it.
      const manualDiscount = Number(discount ?? 0);
      dataToUpdate.subtotal = netItemsSubtotal;
      dataToUpdate.discount = orderDiscount ? round2(manualDiscount + orderDiscount.amount) : round2(manualDiscount);
      dataToUpdate.total = round2(netItemsSubtotal - dataToUpdate.discount + Number(tax ?? existing.tax));
      dataToUpdate.appliedDealId = orderDiscount?.dealId ?? null;
      dataToUpdate.appliedDealCode = orderDiscount?.code ?? null;
      dataToUpdate.appliedDealName = orderDiscount?.dealName ?? null;

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
          dealItemKey: item.dealItemKey ?? null,
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

  // Check ingredient stock — batch-fetch every level in ONE query instead of
  // one findUnique per ingredient. This loop ran serially, so an 8-ingredient
  // order meant 8 sequential round-trips to Neon on the order-placement path.
  const ingredientIds = Object.keys(requiredIngredients);
  const stockByIngredient = new Map<string, number>();
  if (ingredientIds.length > 0) {
    if (kitchenWarehouseId) {
      const rows = await tx.warehouseStock.findMany({
        where: { warehouseId: kitchenWarehouseId, ingredientId: { in: ingredientIds } },
        select: { ingredientId: true, currentStock: true },
      });
      for (const r of rows) stockByIngredient.set(r.ingredientId, Math.max(0, Number(r.currentStock ?? 0)));
    } else {
      const rows = await tx.ingredient.findMany({
        where: { id: { in: ingredientIds } },
        select: { id: true, currentStock: true },
      });
      for (const r of rows) stockByIngredient.set(r.id, Math.max(0, Number(r.currentStock ?? 0)));
    }
  }

  for (const [ingredientId, reqData] of Object.entries(requiredIngredients)) {
    const availableStock = stockByIngredient.get(ingredientId) ?? 0;
    if (availableStock < reqData.qty) {
      throw ApiError.badRequest(
        `Insufficient stock for ingredient "${reqData.name}" (Required: ${reqData.qty.toFixed(2)} ${reqData.unit}, Available: ${availableStock.toFixed(2)} ${reqData.unit}). Order cannot be placed.`
      );
    }
  }

  // Check production item stock (e.g. Pizza Dough) — same batch-fetch, one
  // query instead of one findFirst per production item.
  if (kitchenWarehouseId) {
    const prodItemIds = Object.keys(requiredProdItems);
    const stockByProdItem = new Map<string, number>();
    if (prodItemIds.length > 0) {
      const rows = await tx.productionWarehouseStock.findMany({
        where: { warehouseId: kitchenWarehouseId, productionItemId: { in: prodItemIds } },
        select: { productionItemId: true, currentStock: true },
        orderBy: { id: 'asc' },
      });
      for (const r of rows) {
        // A production item can historically have more than one stock row per
        // warehouse; keep the first deterministically (orderBy id) so this can't
        // pick a different row than the run before.
        if (!stockByProdItem.has(r.productionItemId)) {
          stockByProdItem.set(r.productionItemId, Math.max(0, Number(r.currentStock ?? 0)));
        }
      }
    }
    for (const [productionItemId, reqData] of Object.entries(requiredProdItems)) {
      const availableStock = stockByProdItem.get(productionItemId) ?? 0;
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
        kitchenDealProgress: true,
      },
    });

    await deductStockForConsumedStates(tx, existing, updated.items, prismaStatus, req.user?.id);

    if (prismaStatus === 'READY' || prismaStatus === 'COMPLETED') {
      await tx.orderKitchenProgress.updateMany({
        where: { orderId: id },
        data: { status: 'ready' },
      });
      // A manual whole-order override (e.g. a waiter force-completing the order)
      // fast-forwards every deal dish's own ticket too, same as the shared one above.
      await tx.orderKitchenDealProgress.updateMany({
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

/** PUT /api/orders/:id/kitchen-status — one kitchen advances its progress on an
 *  order. `dealItemKey` (one) or `dealItemKeys` (many, for "Start All Cooking" /
 *  "Mark All Ready") each target a dish's own ticket (OrderKitchenDealProgress);
 *  every item, deal or plain, has such a key (see withDealItemKeys). The batch
 *  form does all the dishes in ONE request / transaction / socket emit instead
 *  of one apiece. A request with neither key is the legacy path: it moves the
 *  order's shared per-kitchen ticket (OrderKitchenProgress), still used for
 *  in-flight orders whose OrderItem rows predate per-dish keys. */
export const updateOrderKitchenStatus = asyncHandler(async (req: Request, res: Response) => {
  const { id } = req.params;
  const { kitchenId, status, dealItemKey, dealItemKeys } = req.body;
  if (!kitchenId) throw ApiError.badRequest('kitchenId is required');
  if (!status || !['preparing', 'ready'].includes(status)) {
    throw ApiError.badRequest('status must be one of: preparing, ready');
  }

  // Normalise to a list of targets. `null` in the list = the legacy shared
  // ticket. Dedup so a caller repeating a key can't double-work.
  const rawTargets: (string | null)[] = Array.isArray(dealItemKeys) && dealItemKeys.length > 0
    ? Array.from(new Set(dealItemKeys.map((k: any) => (k == null ? null : String(k)))))
    : [dealItemKey ?? null];
  const targetKeys = rawTargets.filter((k): k is string => k !== null);
  const targetLegacyShared = rawTargets.includes(null);

  const existing = await prisma.order.findUnique({
    where: { id },
    include: {
      items: { include: { menuItem: { select: { category: { select: { name: true } } } } } },
      kitchenProgress: true,
      kitchenDealProgress: true,
    },
  });
  if (!existing) throw ApiError.notFound('Order not found');
  const scope = resolveOutletScope(req);
  if (scope && existing.outletId !== scope) throw ApiError.notFound('Order not found');

  if (await checkPendingCancellation(id)) {
    throw ApiError.badRequest('Cannot change order status while a cancellation request is pending approval');
  }

  for (const key of targetKeys) {
    if (!existing.items.some((i: any) => i.dealItemKey === key)) {
      throw ApiError.badRequest('This item does not belong to this order');
    }
  }

  const kitchenObj = await prisma.kitchen.findUnique({ where: { id: kitchenId } });
  if (!kitchenObj) throw ApiError.notFound('Kitchen not found');
  const activeKitchens = await prisma.kitchen.findMany({ where: { status: 'active' } });

  const targetKeySet = new Set(targetKeys);
  // Resolves what the legacy shared (null-key) ticket's status would be after
  // this update — only reached by items whose rows predate per-dish keys.
  const sharedStatusAfter = (kId: string): string => {
    if (targetLegacyShared && kId === kitchenId) return status;
    const p = existing.kitchenProgress.find((row) => row.kitchenId === kId);
    return p ? p.status : 'pending';
  };
  // Resolves what one dish's own per-item ticket would be after this update.
  const dealStatusAfter = (kId: string, key: string): string => {
    if (kId === kitchenId && targetKeySet.has(key)) return status;
    const p = existing.kitchenDealProgress.find((row) => row.kitchenId === kId && row.dealItemKey === key);
    return p ? p.status : 'pending';
  };

  // An order is READY automatically once every item's assigned kitchen(s) have
  // marked that dish's own ticket 'ready'. Derived from the order's items ×
  // each active kitchen's assignedCategories, NOT from which progress rows
  // happen to exist: a dish no kitchen has started yet has no ticket at all and
  // must still be judged correctly (not ready).
  let allReadyAfter = status === 'ready';
  if (allReadyAfter && existing.items.length > 0) {
    for (const item of existing.items as any[]) {
      const catName = item.menuItem?.category?.name;
      if (!catName) continue;
      const assigned = activeKitchens.filter(
        (k) => Array.isArray(k.assignedCategories) && k.assignedCategories.includes(catName)
      );
      if (assigned.length === 0) continue;

      const itemReady = item.dealItemKey
        ? assigned.every((k) => dealStatusAfter(k.id, item.dealItemKey) === 'ready')
        : assigned.every((k) => sharedStatusAfter(k.id) === 'ready'); // legacy null-key items only
      if (!itemReady) {
        allReadyAfter = false;
        break;
      }
    }
  }

  const anyStartedAfter = status === 'preparing' || status === 'ready'
    || existing.kitchenProgress.some((p) => p.status === 'preparing' || p.status === 'ready')
    || existing.kitchenDealProgress.some((p) => p.status === 'preparing' || p.status === 'ready');

  const order = await prisma.$transaction(async (tx) => {
    // Serialise concurrent kitchen-status writes on THIS order so the stock
    // deduction guard below can't be raced — two dishes accepted at the same
    // instant, two KDS terminals, or a batch racing a single tap.
    await tx.$queryRaw`SELECT 1 FROM "orders" WHERE id = ${id} FOR UPDATE`;
    const locked = await tx.order.findUniqueOrThrow({ where: { id }, select: { status: true } });

    // Upsert every targeted ticket to `status` in one shot — replaces the old
    // find-or-lazily-create-then-update dance, and does all dishes of a batch
    // in this single transaction.
    for (const key of targetKeySet) {
      await tx.orderKitchenDealProgress.upsert({
        where: { orderId_kitchenId_dealItemKey: { orderId: id, kitchenId, dealItemKey: key } },
        create: { orderId: id, kitchenId, dealItemKey: key, status },
        update: { status },
      });
    }
    if (targetLegacyShared) {
      await tx.orderKitchenProgress.upsert({
        where: { orderId_kitchenId: { orderId: id, kitchenId } },
        create: { orderId: id, kitchenId, status },
        update: { status },
      });
    }

    let newPrismaStatus: string = locked.status;
    if (allReadyAfter) newPrismaStatus = 'READY';
    else if (anyStartedAfter && (locked.status === 'PENDING' || locked.status === 'SCHEDULED')) newPrismaStatus = 'PREPARING';

    const updated = newPrismaStatus !== locked.status
      ? await tx.order.update({
          where: { id },
          data: { status: newPrismaStatus as any },
          include: {
            items: { include: { menuItem: { select: { category: { select: { name: true } } } } } },
            kitchenProgress: true,
            kitchenDealProgress: true,
          },
        })
      : await tx.order.findUniqueOrThrow({
          where: { id },
          include: {
            items: { include: { menuItem: { select: { category: { select: { name: true } } } } } },
            kitchenProgress: true,
            kitchenDealProgress: true,
          },
        });

    // Pass the LOCKED status so the "already consumed?" guard is race-free.
    await deductStockForConsumedStates(tx, { ...existing, status: locked.status }, updated.items, newPrismaStatus, req.user?.id);

    return updated;
  }, { timeout: 30000 });

  const statusUpdated = await runOrderStatusPostEffects(prisma, existing, order, order.status as string, req);
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
      kitchenDealProgress: true,
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
  const { id } = req.params;
  const existing = await prisma.kitchen.findUnique({ where: { id } });
  if (!existing) throw ApiError.notFound('Kitchen not found');

  // OrderKitchenProgress / OrderKitchenDealProgress FK this kitchen with no
  // onDelete rule, so a plain delete throws "Foreign key constraint failed"
  // the moment any order has ever been routed here. Those rows are KDS ticket
  // state only — clear them, then remove the kitchen, in one transaction.
  await prisma.$transaction([
    prisma.orderKitchenProgress.deleteMany({ where: { kitchenId: id } }),
    prisma.orderKitchenDealProgress.deleteMany({ where: { kitchenId: id } }),
    prisma.kitchen.delete({ where: { id } }),
  ]);

  // Removing a kitchen changes what "all cooked" means for an order. Re-derive
  // every still-open order against the reduced roster and promote any that is
  // now fully ready but was stuck only because a kitchen it waited on is gone.
  // Promote-only — this never sends an order backwards.
  const [openOrders, activeKitchens] = await Promise.all([
    prisma.order.findMany({
      where: { status: { in: ['PENDING', 'PREPARING'] } },
      include: {
        items: { include: { menuItem: { select: { category: { select: { name: true } } } } } },
        kitchenProgress: true,
        kitchenDealProgress: true,
      },
    }),
    prisma.kitchen.findMany({ where: { status: 'active' }, select: { id: true, assignedCategories: true } }),
  ]);

  const promoted: string[] = [];
  for (const o of openOrders) {
    if (o.status === 'READY') continue;
    if (computeDerivedOrderStatus(o as any, activeKitchens) !== 'READY') continue;
    const updated = await prisma.order.update({
      where: { id: o.id },
      data: { status: 'READY' as any },
      include: { items: { include: { menuItem: { select: { category: { select: { name: true } } } } } } },
    });
    emitOrderEvent('order:updated', mapOrderOut(updated));
    promoted.push(o.orderNumber);
  }

  res.json(ApiResponse.success(
    { promotedOrders: promoted },
    promoted.length ? `Kitchen deleted — ${promoted.length} order(s) moved to Ready` : 'Kitchen deleted',
  ));
});
