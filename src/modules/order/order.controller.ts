/**
 * Order Controller
 * Phase 5: Orders, Order Items, Kitchens
 */

import type { Request, Response } from 'express';
import { prisma } from '../../config/database.js';
import { ApiResponse } from '../../utils/ApiResponse.js';
import { ApiError } from '../../utils/ApiError.js';
import { asyncHandler } from '../../utils/asyncHandler.js';
import { emitOrderEvent } from '../../socket.js';
import { fifoDrawdown } from '../stock/dough.helpers.js';
import { resolveOutletScope } from '../../middleware/outletScope.js';
import bcrypt from 'bcryptjs';

// ── Enum conversion helpers ──

const TYPE_TO_PRISMA: Record<string, string> = {
  'Dine In': 'DINE_IN',
  'Take Away': 'TAKE_AWAY',
  'Delivery': 'DELIVERY',
  'Online': 'ONLINE',
  'Self Order': 'SELF_ORDER',
  'Foodpanda': 'FOODPANDA',
  'Walk-in': 'WALKIN',
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

function mapOrderOut(order: any): any {
  if (!order) return order;
  return {
    ...order,
    type: TYPE_TO_DISPLAY[order.type] ?? order.type,
    status: STATUS_TO_DISPLAY[order.status] ?? order.status,
    // Normalise Decimal fields to numbers so JSON serialises cleanly
    subtotal: Number(order.subtotal),
    discount: Number(order.discount),
    tax: Number(order.tax),
    total: Number(order.total),
    advancePayment: Number(order.advancePayment),
    items: (order.items ?? []).map((i: any) => ({
      ...i,
      price: Number(i.price),
      discount: Number(i.discount),
      categoryName: i.menuItem?.category?.name ?? null,
    })),
  };
}

// ── Order Number Generation ──

async function generateOrderNumber(): Promise<string> {
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
      modifications: { orderBy: { timestamp: 'desc' } },
    },
  });
  if (!order) throw ApiError.notFound('Order not found');
  const scope = resolveOutletScope(req);
  if (scope && order.outletId !== scope) throw ApiError.notFound('Order not found');
  res.json(ApiResponse.success(mapOrderOut(order)));
});

/** POST /api/orders */
export const createOrder = asyncHandler(async (req: Request, res: Response) => {
  const {
    customerName, phone, customerId, type, subtotal, discount, tax, total,
    paymentMethod, tableNumber, deliveryAddress, riderId, staffName,
    items, isFutureSale, scheduledDate, scheduledTime, futureNotes, advancePayment,
    isUrgent, customerType, orderSource,
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

  const order = await prisma.order.create({
    data: {
      orderNumber,
      outletId: scope,
      customerId: customerId || null,
      customerName: customerName || null,
      phone: phone || null,
      type: prismaType as any,
      subtotal: subtotal ?? 0,
      discount: discount ?? 0,
      tax: tax ?? 0,
      total,
      status: prismaStatus as any,
      paymentMethod: paymentMethod || null,
      date: new Date(),
      time: new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }),
      staffId: req.user?.id || null,
      staffName: staffName || req.user?.name || null,
      tableNumber: tableNumber || null,
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
      items: {
        create: items.map((item: any) => ({
          menuItemId: item.menuItemId || null,
          variantId: item.variantId || null,
          name: item.name,
          price: item.price,
          qty: item.qty,
          discount: item.discount ?? 0,
          modifiers: item.modifiers ?? [],
          cookingTime: item.cookingTime ?? null,
          notes: item.notes || null,
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

  const created = mapOrderOut(order);
  emitOrderEvent('order:created', created);
  res.status(201).json(ApiResponse.created(created, 'Order created'));
});

/** PUT /api/orders/:id */
export const updateOrder = asyncHandler(async (req: Request, res: Response) => {
  const { id } = req.params;
  const existing = await prisma.order.findUnique({ where: { id } });
  if (!existing) throw ApiError.notFound('Order not found');
  const scope = resolveOutletScope(req);
  if (scope && existing.outletId !== scope) throw ApiError.notFound('Order not found');

  const {
    customerName, phone, type, status, subtotal, discount, tax, total,
    paymentMethod, tableNumber, deliveryAddress, riderId, staffName,
    items, isUrgent, customerType,
  } = req.body;

  const order = await prisma.$transaction(async (tx) => {
    if (Array.isArray(items) && items.length > 0) {
      await tx.orderItem.deleteMany({ where: { orderId: id } });
    }
    return tx.order.update({
      where: { id },
      data: {
        ...(customerName !== undefined && { customerName }),
        ...(phone !== undefined && { phone }),
        ...(type && { type: (TYPE_TO_PRISMA[type] ?? type.toUpperCase()) as any }),
        ...(status && { status: (STATUS_TO_PRISMA[status] ?? status.toUpperCase()) as any }),
        ...(subtotal !== undefined && { subtotal }),
        ...(discount !== undefined && { discount }),
        ...(tax !== undefined && { tax }),
        ...(total !== undefined && { total }),
        ...(paymentMethod !== undefined && { paymentMethod }),
        ...(tableNumber !== undefined && { tableNumber }),
        ...(deliveryAddress !== undefined && { deliveryAddress }),
        ...(riderId !== undefined && { riderId }),
        ...(staffName !== undefined && { staffName }),
        ...(isUrgent !== undefined && { isUrgent }),
        ...(customerType !== undefined && { customerType }),
        ...(Array.isArray(items) && items.length > 0 && {
          items: {
            create: items.map((item: any) => ({
              menuItemId: item.menuItemId || null,
              variantId: item.variantId || null,
              name: item.name,
              price: item.price,
              qty: item.qty,
              discount: item.discount ?? 0,
              modifiers: item.modifiers ?? [],
              cookingTime: item.cookingTime ?? null,
              notes: item.notes || null,
            })),
          },
        }),
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
  });

  const updatedOrder = mapOrderOut(order);
  emitOrderEvent('order:updated', updatedOrder);
  res.json(ApiResponse.success(updatedOrder, 'Order updated'));
});

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
      },
    });

    // Deduct ingredient stock the first time an order enters the kitchen pipeline
    // (PREPARING/READY/COMPLETED) — this is when ingredients are physically consumed,
    // not when the order is later marked complete. Idempotent: fires exactly once per
    // order, whichever of these three states it reaches first.
    const CONSUMED_STATES = ['PREPARING', 'READY', 'COMPLETED'];
    const alreadyConsumed = CONSUMED_STATES.includes(existing.status);
    const enteringConsumedState = CONSUMED_STATES.includes(prismaStatus);
    if (enteringConsumedState && !alreadyConsumed) {
      const menuItemIds = updated.items
        .filter((i) => i.menuItemId)
        .map((i) => i.menuItemId as string);

      if (menuItemIds.length > 0) {
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
        for (const item of updated.items) {
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

        // Apply per-ingredient stock decrements (values differ per row, so these stay individual)
        for (const [ingredientId, qty] of deductionEntries) {
          // 1. Deduct global ingredient stock (backward compat)
          await tx.ingredient.update({
            where: { id: ingredientId },
            data: { currentStock: { decrement: qty } },
          });

          // 2. Deduct kitchen warehouse stock (if linked)
          if (kitchenWarehouseId) {
            await tx.warehouseStock.upsert({
              where: {
                warehouseId_ingredientId: {
                  warehouseId: kitchenWarehouseId,
                  ingredientId,
                },
              },
              update: { currentStock: { decrement: qty } },
              create: {
                warehouseId: kitchenWarehouseId,
                ingredientId,
                currentStock: -qty,   // negative = consumed before stock received (audit flag)
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
              adjustedById: req.user?.id ?? null,
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
            await tx.productionWarehouseStock.updateMany({
              where: { productionItemId, warehouseId: kitchenWarehouseId },
              data: { currentStock: { decrement: qty } },
            });
          }
        }
      }
    }

    return updated;
  });

  const statusUpdated = mapOrderOut(order);
  emitOrderEvent('order:updated', statusUpdated);
  res.json(ApiResponse.success(statusUpdated, 'Order status updated'));
});

const CANCEL_AUTHORIZER_ROLES = ['SUPER_ADMIN', 'ADMIN', 'MANAGER', 'FLOOR_MANAGER'];

/** POST /api/orders/:id/cancel */
export const cancelOrder = asyncHandler(async (req: Request, res: Response) => {
  const { id } = req.params;
  const {
    itemIds, reason, authorizedById, managerPin,
    refundAmount, refundMethod, newSubtotal, newTax, newTotal,
  } = req.body;

  if (!reason) throw ApiError.badRequest('Reason is required');
  if (!authorizedById) throw ApiError.badRequest('Authorizing manager is required');
  if (!managerPin) throw ApiError.badRequest('Manager PIN is required');
  if (refundAmount == null) throw ApiError.badRequest('Refund amount is required');
  if (!refundMethod) throw ApiError.badRequest('Refund method is required');
  if (typeof refundAmount !== 'number' || refundAmount < 0) {
    throw ApiError.badRequest('Refund amount must be a non-negative number');
  }
  if (!['cash', 'card', 'online', 'none'].includes(refundMethod)) {
    throw ApiError.badRequest('Invalid refund method');
  }

  const existing = await prisma.order.findUnique({ where: { id }, include: { items: true } });
  if (!existing) throw ApiError.notFound('Order not found');
  const scope = resolveOutletScope(req);
  if (scope && existing.outletId !== scope) throw ApiError.notFound('Order not found');

  if (existing.status === 'COMPLETED' || existing.status === 'CANCELLED') {
    throw ApiError.badRequest('Order cannot be cancelled from its current status');
  }

  const manager = await prisma.user.findUnique({ where: { id: authorizedById } });
  if (!manager || !CANCEL_AUTHORIZER_ROLES.includes(manager.role)) {
    throw ApiError.badRequest('Selected user is not authorized to approve cancellations');
  }
  if (!manager.pinHash) throw ApiError.badRequest('Selected manager has not set a PIN');
  const pinValid = await bcrypt.compare(managerPin, manager.pinHash);
  if (!pinValid) throw ApiError.badRequest('Invalid manager PIN');

  const activeItems = existing.items.filter((i) => i.status !== 'cancelled');
  const isItemCancel = Array.isArray(itemIds) && itemIds.length > 0 && itemIds.length < activeItems.length;

  if (isItemCancel) {
    const validIds = new Set(activeItems.map((i) => i.id));
    for (const tid of itemIds) {
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

  const order = await prisma.$transaction(async (tx) => {
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
    }

    // Waste accounting — only if this order had already entered the kitchen pipeline
    // (Task 3: stock for its active items was already deducted at PREPARING/READY).
    // A still-PENDING order never had stock deducted, so there is nothing to record.
    if (existing.status !== 'PENDING') {
      // Use activeItems (defined above), not existing.items — a prior partial cancel on
      // this order may have already cancelled and waste-recorded some items, and
      // re-including them here would double-count their waste.
      const targetItems = isItemCancel
        ? activeItems.filter((i) => itemIds.includes(i.id))
        : activeItems;
      const menuItemIds = targetItems.filter((i) => i.menuItemId).map((i) => i.menuItemId as string);

      if (menuItemIds.length > 0) {
        const recipes = await tx.foodRecipe.findMany({
          where: { menuItemId: { in: menuItemIds } },
          select: { menuItemId: true, variantId: true, ingredientId: true, productionItemId: true, qtyPerUnit: true },
        });

        const wasteDeductions: Record<string, number> = {};
        const wasteProdDeductions: Record<string, number> = {};
        for (const item of targetItems) {
          if (!item.menuItemId) continue;
          const itemRecipes = recipes.filter((r) => {
            if (r.menuItemId !== item.menuItemId) return false;
            if (item.variantId) return r.variantId === item.variantId;
            return !r.variantId;
          });
          for (const r of itemRecipes) {
            const qty = Number(r.qtyPerUnit) * item.qty;
            if (r.ingredientId) {
              wasteDeductions[r.ingredientId] = (wasteDeductions[r.ingredientId] || 0) + qty;
            } else if (r.productionItemId) {
              wasteProdDeductions[r.productionItemId] = (wasteProdDeductions[r.productionItemId] || 0) + qty;
            }
          }
        }

        let kitchenWarehouseId: string | null = null;
        if (existing.outletId) {
          const kw = await tx.warehouse.findFirst({
            where: { outletId: existing.outletId, type: 'KITCHEN', isActive: true },
            select: { id: true },
          });
          kitchenWarehouseId = kw?.id ?? null;
        }

        const ingredientIds = Object.keys(wasteDeductions);
        if (ingredientIds.length > 0) {
          const ingredients = await tx.ingredient.findMany({
            where: { id: { in: ingredientIds } },
            select: { id: true, name: true, purchasePrice: true, unit: { select: { symbol: true } } },
          });
          const ingredientById = new Map(ingredients.map((i) => [i.id, i]));

          for (const [ingredientId, qty] of Object.entries(wasteDeductions)) {
            const ingredient = ingredientById.get(ingredientId);
            if (!ingredient) continue;
            let unitCost = Number(ingredient.purchasePrice ?? 0);
            if (kitchenWarehouseId) {
              const latestBatch = await tx.stockBatch.findFirst({
                where: { ingredientId, warehouseId: kitchenWarehouseId, unitCost: { not: null } },
                orderBy: { createdAt: 'desc' },
                select: { unitCost: true },
              });
              if (latestBatch?.unitCost != null) unitCost = Number(latestBatch.unitCost);
            }
            await tx.wasteRecord.create({
              data: {
                itemName: ingredient.name,
                quantity: qty,
                unit: ingredient.unit?.symbol ?? null,
                reason: 'Order cancelled after preparation',
                cost: unitCost * qty,
                recordedBy: req.user?.name ?? null,
                outletId: existing.outletId,
                orderId: id,
              },
            });
          }
        }

        const productionItemIds = Object.keys(wasteProdDeductions);
        if (productionItemIds.length > 0 && kitchenWarehouseId) {
          const productionItems = await tx.productionItem.findMany({
            where: { id: { in: productionItemIds } },
            select: { id: true, name: true, unit: true },
          });
          const productionItemById = new Map(productionItems.map((p) => [p.id, p]));

          for (const [productionItemId, qty] of Object.entries(wasteProdDeductions)) {
            const productionItem = productionItemById.get(productionItemId);
            if (!productionItem) continue;
            const latestBatch = await tx.productionBatch.findFirst({
              where: { productionItemId, warehouseId: kitchenWarehouseId, unitCost: { not: null } },
              orderBy: { createdAt: 'desc' },
              select: { unitCost: true },
            });
            const unitCost = latestBatch?.unitCost != null ? Number(latestBatch.unitCost) : 0;
            await tx.wasteRecord.create({
              data: {
                itemName: productionItem.name,
                quantity: qty,
                unit: productionItem.unit,
                reason: 'Order cancelled after preparation',
                cost: unitCost * qty,
                recordedBy: req.user?.name ?? null,
                outletId: existing.outletId,
                orderId: id,
              },
            });
          }
        }
      }
    }

    await tx.orderModificationLog.create({
      data: {
        orderId: id,
        action: isItemCancel ? 'item_cancelled' : 'order_cancelled',
        detail: reason,
        staff: req.user?.name ?? null,
        refundAmount,
        refundMethod,
        authorizedById,
      },
    });

    return tx.order.findUnique({
      where: { id },
      include: {
        items: {
          include: { menuItem: { select: { category: { select: { name: true } } } } },
        },
      },
    });
  });

  const cancelledOrder = mapOrderOut(order);
  emitOrderEvent('order:updated', cancelledOrder);
  res.json(ApiResponse.success(cancelledOrder, 'Order cancelled'));
});

/** DELETE /api/orders/:id */
export const deleteOrder = asyncHandler(async (req: Request, res: Response) => {
  const existing = await prisma.order.findUnique({ where: { id: req.params.id } });
  if (!existing) throw ApiError.notFound('Order not found');
  const scope = resolveOutletScope(req);
  if (scope && existing.outletId !== scope) throw ApiError.notFound('Order not found');
  await prisma.order.delete({ where: { id: req.params.id } });
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
