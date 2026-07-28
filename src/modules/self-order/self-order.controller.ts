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
import { normalizeMenuItem } from '../menu/menu.controller.js';

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

/** GET /api/self-order/menu — the menu catalog is global (no outletId column on
 *  FoodMenuItem/FoodCategory), so every outlet sees the same active/available menu. */
export const getSelfOrderMenu = asyncHandler(async (_req: Request, res: Response) => {
  const categories = await prisma.foodCategory.findMany({
    where: { status: 'active' },
    orderBy: [{ displayOrder: 'asc' }, { name: 'asc' }],
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

  res.json(ApiResponse.success({ categories, items: items.map(normalizeMenuItem) }));
});

/** POST /api/self-order/orders */
export const createSelfOrder = asyncHandler(async (req: Request, res: Response) => {
  const {
    tableId, customerName, customerPhone, guestCount,
    items, subtotal, tax, total, specialInstructions,
  } = req.body;

  if (!tableId) throw ApiError.badRequest('tableId is required');
  if (!customerName?.trim()) throw ApiError.badRequest('Customer name is required');
  if (!customerPhone?.trim()) throw ApiError.badRequest('Phone number is required');
  if (!guestCount || Number(guestCount) < 1) throw ApiError.badRequest('Guest count is required');
  if (!items?.length) throw ApiError.badRequest('Order must have at least one item');
  if (total === undefined || total === null) throw ApiError.badRequest('Total is required');

  const table = await prisma.restaurantTable.findUnique({ where: { id: tableId } });
  if (!table) throw ApiError.notFound('Table not found');
  if (!table.outletId) throw ApiError.badRequest('This table is not assigned to an outlet');

  // Validate every item against the live, available menu — never trust client-sent
  // item existence (price/name are still client-computed today, matching how every
  // other order-creation path in this app already works — see order.controller.ts's
  // createOrder, which has the same trust model for authenticated staff orders).
  const menuItemIds: string[] = items.map((i: any) => i.menuItemId).filter(Boolean);
  const availableMenuItems = menuItemIds.length
    ? await prisma.foodMenuItem.findMany({ where: { id: { in: menuItemIds }, available: true } })
    : [];
  const availableIds = new Set(availableMenuItems.map((m) => m.id));
  for (const item of items) {
    if (item.menuItemId && !availableIds.has(item.menuItemId)) {
      throw ApiError.badRequest(`Item "${item.name || 'unknown'}" is no longer available`);
    }
  }

  const orderNumber = await generateOrderNumber();

  const order = await prisma.order.create({
    data: {
      orderNumber,
      outletId: table.outletId,
      customerName: customerName.trim(),
      phone: customerPhone.trim(),
      type: 'SELF_ORDER',
      subtotal: subtotal ?? 0,
      discount: 0,
      tax: tax ?? 0,
      total,
      status: 'PENDING',
      paymentMethod: 'Pay at Counter',
      date: new Date(),
      time: new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }),
      staffName: 'Self Order',
      tableNumber: !isNaN(Number(table.number)) ? Number(table.number) : null,
      orderSource: 'self-order',
      guestCount: Number(guestCount),
      items: {
        create: items.map((item: any, idx: number) => ({
          menuItemId: item.menuItemId || null,
          name: item.name,
          price: item.price,
          qty: item.qty,
          discount: 0,
          modifiers: item.modifiers ?? [],
          // Order has no order-level notes field; the cart's single special-instructions
          // textarea is carried on the first line item only (existing schema only supports
          // per-item notes — see OrderItem.notes usage in order.controller.ts).
          notes: idx === 0 && specialInstructions ? specialInstructions : (item.notes || null),
        })),
      },
    },
    include: {
      items: { include: { menuItem: { select: { category: { select: { name: true } } } } } },
    },
  });

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
