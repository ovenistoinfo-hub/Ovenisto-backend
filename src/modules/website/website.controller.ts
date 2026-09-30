import { Request, Response } from 'express';
import { PrismaClient } from '@prisma/client';
import { asyncHandler } from '../../utils/asyncHandler.js';
import { ApiError } from '../../utils/ApiError.js';
import { ApiResponse } from '../../utils/ApiResponse.js';
import { buildPublicMenu } from '../menu/publicMenu.js';
import { isDealCurrentlyValid, isDealAvailableForChannel, mapDealOutPublic } from '../deals/deal.pricing.js';
import { getActiveOutlet, getOutletSettings, findOrCreateWebsiteCustomer } from './website.service.js';
import { WEBSITE_ORDER_TYPES, parseWebsiteOrderType, readWebsiteConfig, isAcceptingOrders, WebsiteOrderType, normalizePkPhone, toWebsiteOrderStatus, validateReservationSlot, toWebsiteReservationStatus } from './website.helpers.js';
import { priceWebsiteCart } from './website.pricing.js';
import { emitOrderEvent } from '../../socket.js';
import { mapReservation } from '../reservations/reservation.controller.js';
import { emitReservationEvent } from '../../socket.js';
import { mapOrderOut, generateOrderNumber } from '../order/order.controller.js';

const prisma = new PrismaClient();

export const getOutlets = asyncHandler(async (req: Request, res: Response) => {
  const outlets = await prisma.outlet.findMany({
    where: { isActive: true },
    select: { id: true, name: true, address: true, phone: true, isActive: true },
    orderBy: { name: 'asc' },
  });

  const settings = await prisma.settings.findMany({
    where: { outletId: { in: outlets.map(o => o.id) } },
    select: { outletId: true, onlineOrders: true, websiteConfig: true },
  });
  const settingsByOutlet = Object.fromEntries(settings.map(s => [s.outletId, s]));

  const result = outlets.map(o => {
    const s = settingsByOutlet[o.id];
    const config = readWebsiteConfig(s?.websiteConfig);
    const acceptingOrders = isAcceptingOrders({
      outletActive: true,
      onlineOrders: s?.onlineOrders ?? true,
      config,
    });
    const acceptingReservations = o.isActive && config.reservationsEnabled;
    return {
      id: o.id,
      name: o.name,
      address: o.address,
      phone: o.phone,
      acceptingOrders,
      acceptingReservations,
    };
  });

  res.setHeader('Cache-Control', 'public, max-age=300');
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

  res.setHeader('Cache-Control', 'public, max-age=60');
  res.json(ApiResponse.success({
    outletId: outlet.id,
    outletName: outlet.name,
    acceptingOrders,
    acceptingReservations,
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

export const getMenu = asyncHandler(async (req: Request, res: Response) => {
  const outlet = await getActiveOutlet(req.query.outletId);
  const orderType = parseWebsiteOrderType(req.query.orderType);
  if (!orderType) throw ApiError.badRequest('Invalid orderType');

  const menu = await buildPublicMenu(prisma, { outletId: outlet.id, orderType });

  res.setHeader('Cache-Control', 'public, max-age=60');
  res.json(ApiResponse.success(menu));
});

export const getDeals = asyncHandler(async (req: Request, res: Response) => {
  const outlet = await getActiveOutlet(req.query.outletId);
  const orderType = parseWebsiteOrderType(req.query.orderType);
  if (!orderType) throw ApiError.badRequest('Invalid orderType');

  const deals = await prisma.deal.findMany({
    where: {
      status: { not: 'archived' },
      isActive: true,
      // Legacy ORDER_DISCOUNT rows still exist in production
      type: { notIn: ['PROMO_CODE', 'MIN_SPEND', 'ORDER_DISCOUNT'] },
      ...(orderType === 'Delivery' ? { availableDelivery: true } : {}),
      ...(orderType === 'Take Away' ? { availableTakeaway: true } : {}),
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

  res.setHeader('Cache-Control', 'public, max-age=60');
  res.json(ApiResponse.success(liveDeals.map((d: any) => mapDealOutPublic(d, orderType))));
});

export const quoteCart = asyncHandler(async (req: Request, res: Response) => {
  const { outletId, orderType, items, dealCode } = req.body;
  
  const quote = await priceWebsiteCart(prisma, { outletId, orderType, items, dealCode });
  
  // Return format omitting outlet and itemsData
  const { outlet, itemsData, ...publicQuote } = quote;
  res.json(ApiResponse.success(publicQuote));
});

export const createWebsiteOrder = asyncHandler(async (req: Request, res: Response) => {
  const { outletId, orderType, items, dealCode, customerName, customerPhone, deliveryAddress, specialInstructions, clientRequestId } = req.body;
  
  if (clientRequestId) {
    const existing = await prisma.order.findFirst({
      where: { clientRequestId }
    });
    if (existing) {
      res.status(200).json(ApiResponse.success({
        orderId: existing.id,
        orderNumber: existing.orderNumber,
        total: Number(existing.total),
        status: 'pending'
      }));
      return;
    }
  }

  const priced = await priceWebsiteCart(prisma, { outletId, orderType, items, dealCode });

  if (!priced.acceptingOrders) {
    throw ApiError.conflict('This branch is not taking online orders right now');
  }
  if (!priced.meetsMinOrder) {
    throw ApiError.badRequest(`Minimum order for delivery is Rs. ${priced.minOrder}`);
  }

  const phone = normalizePkPhone(customerPhone);
  if (!phone) {
    throw ApiError.badRequest('Enter a valid mobile number (03XX-XXXXXXX)');
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
      date: now,
      time: now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }),
      staffId: null,
      staffName: 'Website',
      deliveryAddress: orderType === 'Delivery' ? deliveryAddress : null,
      orderSource: 'website',
      cashApproved: true,
      clientRequestId: clientRequestId || null,
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

  const createdOut = mapOrderOut(order);
  emitOrderEvent('order:created', createdOut);

  res.status(201).json(ApiResponse.success({
    orderId: order.id,
    orderNumber: order.orderNumber,
    total: Number(order.total),
    status: 'pending'
  }));
});

export const getWebsiteOrderStatus = asyncHandler(async (req: Request, res: Response) => {
  const { id } = req.params;
  
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) {
    throw ApiError.badRequest('Invalid order ID format');
  }

  const order = await prisma.order.findUnique({ 
    where: { id },
    include: {
      items: { where: { status: 'active' } },
      deliveries: { where: { status: { not: 'returned' } }, orderBy: { assignedAt: 'desc' }, take: 1 },
      outlet: { select: { name: true } }
    }
  });

  if (!order || order.orderSource !== 'website') {
    throw ApiError.notFound('Order not found');
  }
  
  const activeAssignmentStatus = order.deliveries.length > 0 ? order.deliveries[0].status : null;
  const status = toWebsiteOrderStatus(order, activeAssignmentStatus);
  
  const displayType = order.type === 'DELIVERY' ? 'Delivery' : 'Take Away';

  res.setHeader('Cache-Control', 'no-store');
  res.json(ApiResponse.success({
    orderId: order.id,
    orderNumber: order.orderNumber,
    type: displayType,
    status,
    rejectionReason: order.rejectionReason,
    total: Number(order.total),
    deliveryFee: Number(order.deliveryFee || 0),
    items: order.items.map(i => ({ name: i.name, qty: i.qty })),
    outletName: order.outlet?.name || 'Unknown',
    createdAt: order.createdAt
  }));
});

export const createWebsiteReservation = asyncHandler(async (req: Request, res: Response) => {
  const { outletId, customerName, customerPhone, date, time, guestCount, specialRequests } = req.body;

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

  const existing = await prisma.reservation.findFirst({
    where: {
      outletId: outlet.id,
      customerPhone: phone,
      date: new Date(date),
      time,
      source: 'website',
      status: { in: ['pending', 'confirmed'] },
    }
  });

  if (existing) {
    return res.status(200).json(ApiResponse.success({
      reservationId: existing.id,
      status: existing.status,
      date,
      time,
      guestCount: existing.guestCount,
      outletName: outlet.name,
    }));
  }

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
      bookingType: 'table_reservation',
      orderType: 'Dine In',
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
  }));
});

export const getWebsiteReservationStatus = asyncHandler(async (req: Request, res: Response) => {
  const { id } = req.params;
  if (!/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(id)) {
    throw ApiError.badRequest('Invalid reservation ID');
  }

  const reservation = await prisma.reservation.findUnique({
    where: { id },
    include: { outlet: true }
  });

  if (!reservation || reservation.source !== 'website') {
    throw ApiError.notFound('Reservation not found');
  }

  res.setHeader('Cache-Control', 'no-store');
  res.json(ApiResponse.success({
    reservationId: reservation.id,
    status: toWebsiteReservationStatus(reservation.status),
    date: reservation.date.toISOString().slice(0, 10),
    time: reservation.time,
    guestCount: reservation.guestCount,
    outletName: reservation.outlet?.name,
    createdAt: reservation.createdAt,
  }));
});

