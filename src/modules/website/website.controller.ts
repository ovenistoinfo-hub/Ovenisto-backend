import { Request, Response } from 'express';
import { PrismaClient, Prisma } from '@prisma/client';
import { asyncHandler } from '../../utils/asyncHandler.js';
import { ApiError } from '../../utils/ApiError.js';
import { ApiResponse } from '../../utils/ApiResponse.js';
import { buildPublicMenu } from '../menu/publicMenu.js';
import { loadBranchMealTypes } from '../menu/mealTimes.js';
import { isDealCurrentlyValid, isDealAvailableForChannel, mapDealOutPublic } from '../deals/deal.pricing.js';
import { getActiveOutlet, getOutletSettings, findOrCreateWebsiteCustomer } from './website.service.js';
import { WEBSITE_ORDER_TYPES, readWebsiteConfig, isAcceptingOrders, WebsiteOrderType, WebsiteBookingType, parseWebsiteBookingType, normalizePkPhone, toWebsiteOrderStatus, validateReservationSlot, toWebsiteReservationStatus, resolveBranchContact, resolveDeliveryLocation, pktMinuteNow, toMinutes, listMealTimes, attachDealTags, preOrderSignature, pktSlotToMs, validateEventDate, type DealTaggedLine, type PreOrderLineLike } from './website.helpers.js';
import { priceWebsiteCart } from './website.pricing.js';
import { emitOrderEvent } from '../../socket.js';
import { mapReservation } from '../reservations/reservation.controller.js';
import { emitReservationEvent } from '../../socket.js';
import { mapOrderOut, generateOrderNumber } from '../order/order.controller.js';
import { safepayConfig, startPayment, switchToCash, refreshPaymentOrders, returnOriginOf, apiBaseOf } from '../payments/payment.service.js';
import { toPaymentView, toPaymentLike, ONLINE_ORIGIN_MESSAGE } from '../payments/payment.rules.js';

const prisma = new PrismaClient();

// Ends the message when a dish can't be ordered now (outside its meal time, or it must be booked ahead).
const ORDER_NOW_HINT = 'Remove it from your cart, or pre-order it for later from Reservations.';

export const getOutlets = asyncHandler(async (req: Request, res: Response) => {
  const outlets = await prisma.outlet.findMany({
    where: { isActive: true },
    select: { id: true, name: true, address: true, phone: true, email: true, city: true, isActive: true },
    orderBy: { name: 'asc' },
  });

  const settings = await prisma.settings.findMany({
    where: { outletId: { in: outlets.map(o => o.id) } },
    select: { outletId: true, onlineOrders: true, websiteConfig: true, phone: true, address: true, email: true },
  });
  const settingsByOutlet = Object.fromEntries(settings.map(s => [s.outletId, s]));
  const mealTypes = await prisma.mealType.findMany({ where: { status: 'active' }, select: { id: true, name: true } });

  const result = outlets.map(o => {
    const s = settingsByOutlet[o.id];
    const config = readWebsiteConfig(s?.websiteConfig);
    const acceptingOrders = isAcceptingOrders({
      outletActive: true,
      onlineOrders: s?.onlineOrders ?? true,
      config,
    });
    const acceptingReservations = o.isActive && config.reservationsEnabled;
    const contact = resolveBranchContact(o, s, o.id);
    return {
      id: o.id,
      name: o.name,
      address: contact.address,
      phone: contact.phone,
      email: contact.email,
      city: contact.city,
      acceptingOrders,
      acceptingReservations,
      location: config.location,
      hours: config.hours,
      mealTimes: listMealTimes(mealTypes, config.mealHours),
    };
  });

  res.setHeader('Cache-Control', 'no-cache');
  res.json(ApiResponse.success(result));
});

export const getConfig = asyncHandler(async (req: Request, res: Response) => {
  const outletId = req.query.outletId as string;
  if (!outletId) throw ApiError.badRequest('outletId is required');

  const outlet = await getActiveOutlet(outletId);
  const settings = await getOutletSettings(outlet.id);
  
  const config = readWebsiteConfig(settings?.websiteConfig);
  const acceptingOrders = isAcceptingOrders({
    outletActive: outlet.isActive,
    onlineOrders: settings?.onlineOrders ?? true,
    config,
  });

  const acceptingReservations = outlet.isActive && config.reservationsEnabled;
  // "Pay online" shows only when the branch switched it on AND the server has the Safepay keys.
  const onlinePaymentAvailable = acceptingOrders && config.onlinePayment && !!safepayConfig;

  res.setHeader('Cache-Control', 'no-cache');
  res.json(ApiResponse.success({
    outletId: outlet.id,
    outletName: outlet.name,
    acceptingOrders,
    acceptingReservations,
    onlinePaymentAvailable,
    firstOrderDiscount: config.firstOrderDiscount.enabled ? { percent: config.firstOrderDiscount.percent } : null,
    reservationsEnabled: config.reservationsEnabled,
    orderTypes: WEBSITE_ORDER_TYPES,
    deliveryFee: config.deliveryFee,
    freeDeliveryAbove: config.freeDeliveryAbove,
    minOrder: config.minOrder,
    prepTimeMinutes: config.prepTimeMinutes,
    taxRate: settings?.taxRate != null ? Number(settings.taxRate) : 16,
    taxName: settings?.taxName ?? 'GST',
    currency: settings?.currency ?? 'Rs.',
  }));
});

// Menu and deals also serve Dine In, for reservation pre-orders.
export const getMenu = asyncHandler(async (req: Request, res: Response) => {
  const outlet = await getActiveOutlet(req.query.outletId);
  const orderType = parseWebsiteBookingType(req.query.orderType);
  if (!orderType) throw ApiError.badRequest('Invalid orderType');

  // mealTypes: this branch's serving time per meal type (null = all day), for the filter and "served" labels.
  const [menu, mealTypes] = await Promise.all([
    buildPublicMenu(prisma, { outletId: outlet.id, orderType }),
    loadBranchMealTypes(prisma, outlet.id),
  ]);

  res.setHeader('Cache-Control', 'no-cache');
  res.json(ApiResponse.success({ ...menu, mealTypes }));
});

export const getDeals = asyncHandler(async (req: Request, res: Response) => {
  const outlet = await getActiveOutlet(req.query.outletId);
  const orderType = parseWebsiteBookingType(req.query.orderType);
  if (!orderType) throw ApiError.badRequest('Invalid orderType');

  const deals = await prisma.deal.findMany({
    where: {
      status: { not: 'archived' },
      isActive: true,
      // Legacy ORDER_DISCOUNT rows still exist in production
      type: { notIn: ['PROMO_CODE', 'MIN_SPEND', 'ORDER_DISCOUNT'] },
      ...(orderType === 'Delivery' ? { availableDelivery: true } : {}),
      ...(orderType === 'Take Away' ? { availableTakeaway: true } : {}),
      ...(orderType === 'Dine In' ? { availableDineIn: true } : {}),
      OR: [{ outletIds: { isEmpty: true } }, { outletIds: { has: outlet.id } }],
    },
    include: {
      components: { orderBy: { displayOrder: 'asc' as const } },
      bogoItems: { orderBy: { displayOrder: 'asc' as const } },
      optionGroups: {
        orderBy: { displayOrder: 'asc' as const },
        include: { options: { orderBy: { displayOrder: 'asc' as const } } },
      },
    },
    orderBy: { createdAt: 'desc' },
  });

  const liveDeals = deals.filter(
    (d: any) => isDealCurrentlyValid(d).valid && isDealAvailableForChannel(d, orderType),
  );

  res.setHeader('Cache-Control', 'no-cache');
  res.json(ApiResponse.success(liveDeals.map((d: any) => mapDealOutPublic(d, orderType))));
});

export const quoteCart = asyncHandler(async (req: Request, res: Response) => {
  const { outletId, orderType, items, dealCode, customerPhone } = req.body;
  
  const quote = await priceWebsiteCart(prisma, {
    outletId, orderType, items, dealCode,
    servedAt: { minute: pktMinuteNow(), hint: ORDER_NOW_HINT },
    // Signed in (optional on quotes): the first-order offer shows before the order is placed.
    firstOrder: { uid: res.locals.customerUid ?? null, phone: normalizePkPhone(customerPhone) },
  });
  
  // Return format omitting outlet and itemsData
  const { outlet, itemsData, ...publicQuote } = quote;
  res.json(ApiResponse.success(publicQuote));
});

export const createWebsiteOrder = asyncHandler(async (req: Request, res: Response) => {
  const { outletId, orderType, items, dealCode, customerName, customerPhone, deliveryAddress, deliveryLocation, specialInstructions, clientRequestId, paymentChoice } = req.body;
  
  if (clientRequestId) {
    const existing = await prisma.order.findFirst({
      where: { clientRequestId }
    });
    if (existing) {
      res.status(200).json(ApiResponse.success({
        orderId: existing.id,
        orderNumber: existing.orderNumber,
        total: Number(existing.total),
        status: toWebsiteOrderStatus(existing, null),
        checkoutUrl: null,
      }));
      return;
    }
  }

  const phone = normalizePkPhone(customerPhone);
  if (!phone) {
    throw ApiError.badRequest('Enter a valid mobile number (03XX-XXXXXXX)');
  }

  const priced = await priceWebsiteCart(prisma, {
    outletId, orderType, items, dealCode,
    servedAt: { minute: pktMinuteNow(), hint: ORDER_NOW_HINT },
    firstOrder: { uid: res.locals.customerUid ?? null, phone },
  });

  if (!priced.acceptingOrders) {
    throw ApiError.conflict('This branch is not taking online orders right now');
  }
  if (!priced.meetsMinOrder) {
    throw ApiError.badRequest(`Minimum order for delivery is Rs. ${priced.minOrder}`);
  }

  // Pay online: the branch must offer it and the server must have the Safepay keys. The browser's origin
  // is where Safepay sends the customer back, so it has to be one the CORS rule allows.
  const payOnline = paymentChoice === 'online';
  const returnOrigin = payOnline ? returnOriginOf(req) : null;
  if (payOnline) {
    const branchConfig = readWebsiteConfig((await getOutletSettings(priced.outlet.id))?.websiteConfig);
    if (!branchConfig.onlinePayment || !safepayConfig) {
      throw ApiError.conflict("Online payment isn't available for this branch right now");
    }
    if (!returnOrigin) throw ApiError.badRequest(ONLINE_ORIGIN_MESSAGE);
  }

  // Find or create customer
  const customer = await findOrCreateWebsiteCustomer(prisma, { 
    name: customerName, 
    phone, 
    address: orderType === 'Delivery' ? deliveryAddress : null 
  });

  // Apply special instructions to the first item's notes if it lacks notes
  if (specialInstructions && priced.itemsData.length > 0) {
    if (!priced.itemsData[0].notes) {
      priced.itemsData[0].notes = specialInstructions;
    }
  }

  const orderNumber = await generateOrderNumber();
  const dbOrderType = orderType === 'Delivery' ? 'DELIVERY' : 'TAKE_AWAY';
  const now = new Date();
  
  const resolvedLocation = resolveDeliveryLocation(orderType, deliveryLocation);

  const order = await prisma.order.create({
    data: {
      orderNumber,
      outletId: priced.outlet.id,
      customerId: customer.id,
      customerName,
      phone,
      type: dbOrderType,
      subtotal: priced.subtotal,
      discount: priced.discount,
      tax: priced.tax,
      deliveryFee: priced.deliveryFee,
      total: priced.total,
      appliedDealId: priced.appliedDeal?.dealId || null,
      appliedDealCode: priced.appliedDeal?.code || null,
      appliedDealName: priced.appliedDeal?.dealName || null,
      paymentMethod: 'Pending',
      status: payOnline ? 'AWAITING_PAYMENT' : 'PENDING',
      date: now,
      time: now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }),
      staffId: null,
      staffName: 'Website',
      deliveryAddress: orderType === 'Delivery' ? deliveryAddress : null,
      deliveryLat: resolvedLocation?.lat ?? null,
      deliveryLng: resolvedLocation?.lng ?? null,
      orderSource: 'website',
      cashApproved: true,
      clientRequestId: clientRequestId || null,
      customerUid: res.locals.customerUid ?? null,
      items: {
        create: priced.itemsData.map(i => ({
          menuItemId: i.menuItemId,
          variantId: i.variantId,
          name: i.name,
          price: i.price,
          qty: i.qty,
          discount: i.discount,
          modifiers: i.modifiers,
          modifierIds: i.modifierIds,
          cookingTime: i.cookingTime,
          notes: i.notes,
          dealId: i.dealId,
          dealName: i.dealName,
          dealLineId: i.dealLineId,
          dealItemKey: i.dealItemKey,
        })),
      },
    },
    include: {
      items: { include: { menuItem: { select: { category: { select: { name: true } } } } } },
    }
  });

  if (payOnline && returnOrigin) {
    // Staff see it only once Safepay confirms the payment (payment.service.ts confirmPayment).
    let checkoutUrl: string | null = null;
    try {
      checkoutUrl = await startPayment(order, { returnOrigin, apiBase: apiBaseOf(req) });
    } catch (err) {
      // The order page still offers Pay now / Pay cash instead.
      console.error(`[safepay] could not start a payment for ${order.orderNumber}:`, err);
    }
    res.status(201).json(ApiResponse.success({
      orderId: order.id,
      orderNumber: order.orderNumber,
      total: Number(order.total),
      status: 'awaiting_payment',
      checkoutUrl,
    }));
    return;
  }

  const createdOut = mapOrderOut(order);
  emitOrderEvent('order:created', createdOut);

  res.status(201).json(ApiResponse.success({
    orderId: order.id,
    orderNumber: order.orderNumber,
    total: Number(order.total),
    status: 'pending',
    checkoutUrl: null,
  }));
});

const ORDER_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const getWebsiteOrderStatus = asyncHandler(async (req: Request, res: Response) => {
  const { id } = req.params;
  
  if (!ORDER_ID_RE.test(id)) {
    throw ApiError.badRequest('Invalid order ID format');
  }

  await refreshPaymentOrders({ id });

  const order = await prisma.order.findUnique({
    where: { id },
    include: ORDER_STATUS_INCLUDE,
  });

  if (!order || order.orderSource !== 'website') {
    throw ApiError.notFound('Order not found');
  }

  res.setHeader('Cache-Control', 'no-store');
  res.json(ApiResponse.success(toOrderStatusView(order)));
});

// The order status view, shared by /orders/:id/status and /my/orders.
const ORDER_STATUS_INCLUDE = {
  items: { where: { status: 'active' } },
  deliveries: { where: { status: { not: 'returned' } }, orderBy: { assignedAt: 'desc' }, take: 1 },
  outlet: { select: { name: true } },
  payments: { select: { id: true, status: true, amount: true, refundedAmount: true, paidAt: true } },
} satisfies Prisma.OrderInclude;

function toOrderStatusView(order: Prisma.OrderGetPayload<{ include: typeof ORDER_STATUS_INCLUDE }>) {
  const activeAssignmentStatus = order.deliveries.length > 0 ? order.deliveries[0].status : null;
  return {
    orderId: order.id,
    orderNumber: order.orderNumber,
    type: order.type === 'DELIVERY' ? 'Delivery' : 'Take Away',
    status: toWebsiteOrderStatus(order, activeAssignmentStatus),
    rejectionReason: order.rejectionReason,
    total: Number(order.total),
    deliveryFee: Number(order.deliveryFee || 0),
    items: order.items.map(i => ({ name: i.name, qty: i.qty })),
    outletName: order.outlet?.name || 'Unknown',
    createdAt: order.createdAt,
    payment: toPaymentView(
      { status: order.status, total: Number(order.total), paymentMethod: order.paymentMethod },
      order.payments.map(toPaymentLike)
    ),
  };
}

/** The signed-in customer's Firebase uid (set by requireWebsiteCustomer). Never query without one. */
function signedInUid(res: Response): string {
  const uid = res.locals.customerUid as string | undefined;
  if (!uid) throw ApiError.unauthorized('Please sign in to continue');
  return uid;
}

export const getMyWebsiteOrders = asyncHandler(async (req: Request, res: Response) => {
  const uid = signedInUid(res);
  await refreshPaymentOrders({ customerUid: uid });
  const orders = await prisma.order.findMany({
    where: { customerUid: uid, orderSource: 'website' },
    include: ORDER_STATUS_INCLUDE,
    orderBy: { createdAt: 'desc' },
    take: 50,
  });
  res.setHeader('Cache-Control', 'no-store');
  res.json(ApiResponse.success(orders.map(toOrderStatusView)));
});

/** The signed-in customer's own website order that is still waiting for its online payment. */
async function loadAwaitingOrder(req: Request, res: Response) {
  const uid = signedInUid(res);
  const { id } = req.params;
  if (!ORDER_ID_RE.test(id)) throw ApiError.badRequest('Invalid order ID format');
  await refreshPaymentOrders({ id });
  const order = await prisma.order.findUnique({ where: { id } });
  if (!order || order.orderSource !== 'website' || order.customerUid !== uid) throw ApiError.notFound('Order not found');
  if (order.status !== 'AWAITING_PAYMENT') throw ApiError.conflict('This order is no longer waiting for payment');
  return order;
}

/** POST /website/orders/:id/pay — a new Safepay checkout for the same order (try again). */
export const payWebsiteOrder = asyncHandler(async (req: Request, res: Response) => {
  const order = await loadAwaitingOrder(req, res);
  const returnOrigin = returnOriginOf(req);
  if (!returnOrigin) throw ApiError.badRequest(ONLINE_ORIGIN_MESSAGE);
  let checkoutUrl: string;
  try {
    checkoutUrl = await startPayment(order, { returnOrigin, apiBase: apiBaseOf(req) });
  } catch (err) {
    if (err instanceof ApiError) throw err;
    console.error(`[safepay] could not start a payment for ${order.orderNumber}:`, err);
    throw ApiError.conflict("Couldn't open the payment page. Try again in a minute, or pay cash instead.");
  }
  res.json(ApiResponse.success({ checkoutUrl }));
});

/** POST /website/orders/:id/pay-cash — give up on paying online; it becomes a normal cash order. */
export const payCashWebsiteOrder = asyncHandler(async (req: Request, res: Response) => {
  const order = await loadAwaitingOrder(req, res);
  await switchToCash(order.id);
  res.json(ApiResponse.success({ orderId: order.id, status: 'pending' }));
});

interface ReservationItemInput extends DealTaggedLine {
  name: string;
  qty: number;
  modifierIds?: string[];
  notes?: string | null;
  dealId?: string | null;
}

const RESERVATION_MEAL_HINT = 'Remove it from your pre-order, or pick another time.';

// Same figures as /website/quote, for a booking: Dine In allowed, no stock check (the booking is for
// a later date), no coupon code (a Minimum Spend deal still auto-applies inside the kernel).
export const quoteWebsiteReservation = asyncHandler(async (req: Request, res: Response) => {
  const { outletId, orderType, items, time, date } = req.body as { outletId: string; orderType: WebsiteBookingType; items: ReservationItemInput[]; time?: string; date?: string };

  const outlet = await getActiveOutlet(outletId);
  const settings = await getOutletSettings(outlet.id);
  const config = readWebsiteConfig(settings?.websiteConfig);
  const acceptingReservations = outlet.isActive && config.reservationsEnabled;

  if (items.length === 0) {
    // Only Dine In gets here (the schema requires items otherwise): a table booking with no pre-order.
    res.json(ApiResponse.success({
      acceptingReservations,
      lines: [],
      subtotal: 0,
      discount: 0,
      appliedDeal: null,
      taxRate: settings?.taxRate != null ? Number(settings.taxRate) : 16,
      tax: 0,
      deliveryFee: 0,
      total: 0,
      minOrder: config.minOrder,
      meetsMinOrder: true,
      freeDeliveryAbove: config.freeDeliveryAbove,
    }));
    return;
  }

  // Once a time is picked, dishes are checked against it (Breakfast items at a lunch booking are refused).
  const servedAt = time ? { minute: toMinutes(time), hint: RESERVATION_MEAL_HINT } : undefined;
  // With the date too, a dish that must be booked hours ahead is checked against the booking.
  const advance = time && date ? { bookingMs: pktSlotToMs(date, time), hint: RESERVATION_MEAL_HINT } : undefined;
  const priced = await priceWebsiteCart(prisma, { outletId: outlet.id, orderType, items, checkStock: false, servedAt, advance });
  res.json(ApiResponse.success({
    acceptingReservations,
    lines: priced.lines,
    subtotal: priced.subtotal,
    discount: priced.discount,
    appliedDeal: priced.appliedDeal,
    taxRate: priced.taxRate,
    tax: priced.tax,
    deliveryFee: priced.deliveryFee,
    total: priced.total,
    minOrder: priced.minOrder,
    meetsMinOrder: priced.meetsMinOrder,
    freeDeliveryAbove: priced.freeDeliveryAbove,
  }));
});

export const createWebsiteReservation = asyncHandler(async (req: Request, res: Response) => {
  const {
    outletId, customerName, customerPhone, date, time, guestCount, specialRequests,
    orderType, items, deliveryAddress, deliveryLocation,
  } = req.body as {
    outletId: string; customerName: string; customerPhone: string; date: string; time: string;
    guestCount: number; specialRequests?: string; orderType: WebsiteBookingType;
    items: ReservationItemInput[]; deliveryAddress?: string; deliveryLocation?: unknown;
  };

  const outlet = await getActiveOutlet(outletId);
  const settings = await getOutletSettings(outlet.id);
  const config = readWebsiteConfig(settings?.websiteConfig);
  if (!config.reservationsEnabled) {
    throw ApiError.conflict('This branch is not taking online reservations right now');
  }

  const phone = normalizePkPhone(customerPhone);
  if (!phone) {
    throw ApiError.badRequest('Enter a valid mobile number (03XX-XXXXXXX)');
  }

  const slotError = validateReservationSlot({ date, time, nowMs: Date.now() });
  if (slotError) {
    throw ApiError.badRequest(slotError);
  }

  // A double-submit of the same booking gets the stored one back. The same slot with another type is a
  // separate booking. The same type with a different pre-order is refused, never swallowed: the website
  // clears the customer's cart once a booking succeeds.
  const existing = await prisma.reservation.findFirst({
    where: {
      outletId: outlet.id,
      customerPhone: phone,
      date: new Date(date),
      time,
      orderType,
      source: 'website',
      status: { in: ['pending', 'confirmed'] },
    }
  });

  if (existing) {
    const storedLines = Array.isArray(existing.preOrderItems) ? existing.preOrderItems as unknown as PreOrderLineLike[] : null;
    if (preOrderSignature(storedLines) !== preOrderSignature(items)) {
      const label = orderType === 'Take Away' ? 'pickup' : orderType === 'Delivery' ? 'delivery' : 'table';
      throw ApiError.conflict(`You already have a ${label} booking at ${time} on ${date}. Pick another time, or call the branch to change it.`);
    }
    return res.status(200).json(ApiResponse.success({
      reservationId: existing.id,
      status: existing.status,
      date,
      time,
      guestCount: existing.guestCount,
      outletName: outlet.name,
      orderType: existing.orderType,
      totalAmount: Number(existing.totalAmount),
    }));
  }

  // Price the pre-order before anything is written, so a bad item or deal rejects the whole booking.
  const priced = items.length > 0
    ? await priceWebsiteCart(prisma, {
        outletId: outlet.id, orderType, items, checkStock: false,
        servedAt: { minute: toMinutes(time), hint: RESERVATION_MEAL_HINT },
        advance: { bookingMs: pktSlotToMs(date, time), hint: RESERVATION_MEAL_HINT },
      })
    : null;
  if (priced && !priced.meetsMinOrder) {
    throw ApiError.badRequest(`Minimum order for delivery is Rs. ${priced.minOrder}`);
  }
  // Stored in the staff pre-order line shape; convertReservationToOrder revalidates deal lines again
  // later, so the client's deal tags are put back on (attachDealTags).
  const preOrderItems = priced
    ? attachDealTags(priced.itemsData, items).map((i) => ({
        menuItemId: i.menuItemId ?? null,
        variantId: i.variantId ?? null,
        name: i.name,
        price: i.price,
        qty: i.qty,
        discount: i.discount ?? 0,
        modifiers: i.modifiers ?? [],
        modifierIds: i.modifierIds ?? [],
        notes: i.notes ?? null,
        dealId: i.dealId ?? null,
        dealName: i.dealName ?? null,
        dealLineId: i.dealLineId ?? null,
        dealGroupId: i.dealGroupId ?? null,
        dealRole: i.dealRole ?? null,
      }))
    : null;
  const location = resolveDeliveryLocation(orderType, deliveryLocation);

  await findOrCreateWebsiteCustomer(prisma, { name: customerName, phone });

  const reservation = await prisma.reservation.create({
    data: {
      customerName,
      customerPhone: phone,
      date: new Date(date),
      time,
      guestCount,
      status: 'pending',
      specialRequests: specialRequests ?? null,
      source: 'website',
      outletId: outlet.id,
      // Staff convention: a Dine In booking is a table reservation, Take Away / Delivery a future order.
      bookingType: orderType === 'Dine In' ? 'table_reservation' : 'future_order',
      orderType,
      deliveryAddress: orderType === 'Delivery' ? deliveryAddress ?? null : null,
      deliveryLat: location?.lat ?? null,
      deliveryLng: location?.lng ?? null,
      ...(preOrderItems ? { preOrderItems } : {}),
      subtotal: priced?.subtotal ?? 0,
      discount: priced?.discount ?? 0,
      tax: priced?.tax ?? 0,
      deliveryFee: priced?.deliveryFee ?? 0,
      totalAmount: priced?.total ?? 0,
      customerUid: res.locals.customerUid ?? null,
    }
  });

  emitReservationEvent('reservation:created', mapReservation(reservation), [outlet.id]);

  return res.status(201).json(ApiResponse.success({
    reservationId: reservation.id,
    status: 'pending',
    date,
    time,
    guestCount,
    outletName: outlet.name,
    orderType,
    totalAmount: priced?.total ?? 0,
  }));
});

export const getWebsiteReservationStatus = asyncHandler(async (req: Request, res: Response) => {
  const { id } = req.params;
  if (!/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(id)) {
    throw ApiError.badRequest('Invalid reservation ID');
  }

  const reservation = await prisma.reservation.findUnique({
    where: { id },
    include: RESERVATION_STATUS_INCLUDE,
  });

  if (!reservation || reservation.source !== 'website') {
    throw ApiError.notFound('Reservation not found');
  }

  res.setHeader('Cache-Control', 'no-store');
  res.json(ApiResponse.success(toReservationStatusView(reservation)));
});

// The booking status view, shared by /reservations/:id/status and /my/reservations.
const RESERVATION_STATUS_INCLUDE = { outlet: { select: { name: true } } } satisfies Prisma.ReservationInclude;

function toReservationStatusView(reservation: Prisma.ReservationGetPayload<{ include: typeof RESERVATION_STATUS_INCLUDE }>) {
  return {
    reservationId: reservation.id,
    status: toWebsiteReservationStatus(reservation.status),
    date: reservation.date.toISOString().slice(0, 10),
    time: reservation.time,
    guestCount: reservation.guestCount,
    outletName: reservation.outlet?.name,
    orderType: reservation.orderType,
    totalAmount: Number(reservation.totalAmount),
    createdAt: reservation.createdAt,
  };
}

export const getMyWebsiteReservations = asyncHandler(async (req: Request, res: Response) => {
  const reservations = await prisma.reservation.findMany({
    where: { customerUid: signedInUid(res), source: 'website' },
    include: RESERVATION_STATUS_INCLUDE,
    orderBy: { createdAt: 'desc' },
    take: 50,
  });
  res.setHeader('Cache-Control', 'no-store');
  res.json(ApiResponse.success(reservations.map(toReservationStatusView)));
});

/** GET /website/best-sellers?outletId= — this branch's most-sold dishes over the last 30 days (completed orders); ids only. */
export const getBestSellers = asyncHandler(async (req: Request, res: Response) => {
  const outlet = await getActiveOutlet(req.query.outletId);
  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const rows = await prisma.orderItem.groupBy({
    by: ['menuItemId'],
    where: { menuItemId: { not: null }, status: 'active', order: { outletId: outlet.id, status: 'COMPLETED', createdAt: { gte: since } } },
    _sum: { qty: true },
    orderBy: { _sum: { qty: 'desc' } },
    take: 8,
  });
  res.setHeader('Cache-Control', 'no-cache');
  res.json(ApiResponse.success({ menuItemIds: rows.map((r) => r.menuItemId).filter((id): id is string => !!id) }));
});

/** GET /website/coming-soon — dishes customers can vote for, most wanted first. */
export const getComingSoon = asyncHandler(async (_req: Request, res: Response) => {
  const dishes = await prisma.comingSoonDish.findMany({
    where: { isActive: true },
    orderBy: [{ votes: 'desc' }, { createdAt: 'asc' }],
    select: { id: true, name: true, description: true, votes: true },
  });
  res.setHeader('Cache-Control', 'no-cache');
  res.json(ApiResponse.success(dishes));
});

/** POST /website/coming-soon/:id/vote — one more "I want this" (the website lets a browser vote once per dish). */
export const voteComingSoon = asyncHandler(async (req: Request, res: Response) => {
  const updated = await prisma.comingSoonDish.updateMany({ where: { id: req.params.id, isActive: true }, data: { votes: { increment: 1 } } });
  if (updated.count === 0) throw ApiError.notFound('Dish not found');
  const dish = await prisma.comingSoonDish.findUnique({ where: { id: req.params.id }, select: { id: true, votes: true } });
  res.json(ApiResponse.success(dish));
});

/** POST /website/suggestions — "Which new dish should we start?" */
export const createDishSuggestion = asyncHandler(async (req: Request, res: Response) => {
  const { text, outletId } = req.body as { text: string; outletId?: string };
  await prisma.dishSuggestion.create({ data: { text, outletId: outletId ?? null } });
  res.status(201).json(ApiResponse.success({ received: true }, 'Thanks for the suggestion'));
});

/** POST /website/event-inquiries — an event or catering quote request; the branch calls back. */
export const createEventInquiry = asyncHandler(async (req: Request, res: Response) => {
  const { outletId, eventType, eventDate, guests, venue, name, phone, notes } = req.body as {
    outletId: string; eventType: string; eventDate: string; guests: number; venue: string; name: string; phone: string; notes?: string;
  };
  const outlet = await getActiveOutlet(outletId);
  const dateError = validateEventDate(eventDate, Date.now());
  if (dateError) throw ApiError.badRequest(dateError);
  const cleanPhone = normalizePkPhone(phone);
  if (!cleanPhone) throw ApiError.badRequest('Enter a valid mobile number (03XX-XXXXXXX)');
  const inquiry = await prisma.eventInquiry.create({
    data: { outletId: outlet.id, eventType, eventDate: new Date(eventDate), guests, venue, name, phone: cleanPhone, notes: notes || null },
  });
  res.status(201).json(ApiResponse.success({ inquiryId: inquiry.id, outletName: outlet.name }));
});

