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
 *  time and does not trust anything about how the client got here. */
export const lookupCustomerByPhone = asyncHandler(async (req: Request, res: Response) => {
  const cleanPhone = String(req.query.phone || '').replace(/\D/g, '');
  if (cleanPhone.length < 7) {
    res.json(ApiResponse.success({ exists: false }));
    return;
  }
  const customer = await prisma.customer.findFirst({ where: { phone: { contains: cleanPhone } } });
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
    category: item.category ? { id: item.category.id, name: item.category.name } : null,
    variants: item.variants.map((v) => ({ id: v.id, name: v.name, price: Number(v.price) })),
    modifiers: item.modifiers
      .filter((mm) => mm.modifier.status === 'active')
      .map((mm) => ({ id: mm.modifier.id, name: mm.modifier.name, price: Number(mm.modifier.price) })),
  }));

  res.json(ApiResponse.success({ categories, items: publicItems }));
});

/** POST /api/self-order/orders */
export const createSelfOrder = asyncHandler(async (req: Request, res: Response) => {
  const {
    tableId, customerName, customerPhone, guestCount,
    items, specialInstructions,
  } = req.body;

  if (!tableId) throw ApiError.badRequest('tableId is required');
  if (!customerName?.trim()) throw ApiError.badRequest('Customer name is required');
  if (!customerPhone?.trim()) throw ApiError.badRequest('Phone number is required');
  if (!guestCount || Number(guestCount) < 1) throw ApiError.badRequest('Guest count is required');
  if (!items?.length) throw ApiError.badRequest('Order must have at least one item');

  const table = await prisma.restaurantTable.findUnique({ where: { id: tableId } });
  if (!table) throw ApiError.notFound('Table not found');
  if (!table.outletId) throw ApiError.badRequest('This table is not assigned to an outlet');

  // Validate every item against the live, available menu — never trust client-sent
  // item existence, price, or modifier selection. Fetch full records so price can
  // be recomputed server-side.
  const menuItemIds: string[] = items.map((i: any) => i.menuItemId).filter(Boolean);
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
  const itemsData = items.map((item: any, idx: number) => {
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

    // Order has no order-level notes field; the cart's single special-instructions
    // textarea is carried on the first line item only (existing schema only supports
    // per-item notes — see OrderItem.notes usage in order.controller.ts).
    return {
      menuItemId: item.menuItemId || null,
      variantId,
      name: item.name,
      price: unitPrice,
      qty,
      discount: 0,
      modifiers: modifierNames,
      notes: idx === 0 && specialInstructions ? specialInstructions : (item.notes || null),
    };
  });
  const computedTax = Math.round(computedSubtotal * (taxRatePercent / 100));
  const computedTotal = computedSubtotal + computedTax;

  // Find-or-link a Customer record by phone. Deliberately narrower than the
  // admin createCustomer endpoint: this NEVER updates an existing customer's
  // saved name — only Order.customerName (a snapshot) reflects whatever name
  // was confirmed at the entry gate. See Global Constraints.
  const cleanCustomerPhone = customerPhone.trim().replace(/\D/g, '');
  let customer = cleanCustomerPhone.length >= 7
    ? await prisma.customer.findFirst({ where: { phone: { contains: cleanCustomerPhone } } })
    : null;
  if (!customer) {
    customer = await prisma.customer.create({
      data: { name: customerName.trim(), phone: customerPhone.trim(), customerType: 'walk-in' },
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
      discount: 0,
      tax: computedTax,
      total: computedTotal,
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

  emitOrderEvent('order:created', mapOrderOut(order));
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
    status,
    accepted: !!order.acceptedById,
    rejectionReason: order.rejectionReason ?? undefined,
  }));
});
