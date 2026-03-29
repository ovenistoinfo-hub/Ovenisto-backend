/**
 * Stock Challan Controller — Phase W3 / W6
 */
import type { Request, Response } from 'express';
import { prisma } from '../../config/database.js';
import { ApiResponse } from '../../utils/ApiResponse.js';
import { ApiError } from '../../utils/ApiError.js';
import { asyncHandler } from '../../utils/asyncHandler.js';

const ADMIN_ROLES = ['Super Admin', 'Admin'];

// Shared include block — add outletId to warehouse selects (W6)
const CHALLAN_INCLUDE = {
  fromWarehouse: { select: { id: true, name: true, type: true, outletId: true } },
  toWarehouse:   { select: { id: true, name: true, type: true, outletId: true } },
  items: {
    include: {
      ingredient: { select: { id: true, name: true, unit: { select: { symbol: true, name: true } } } },
    },
  },
  dispatchedBy: { select: { id: true, name: true } },
  receivedBy:   { select: { id: true, name: true } },
  createdBy:    { select: { id: true, name: true } },
};

function mapChallan(c: any) {
  return {
    id: c.id,
    challanNo: c.challanNo,
    status: c.status,
    notes: c.notes,
    fromWarehouse: c.fromWarehouse ? {
      id: c.fromWarehouse.id,
      name: c.fromWarehouse.name,
      type: c.fromWarehouse.type,
      outletId: c.fromWarehouse.outletId ?? null,
    } : null,
    toWarehouse: c.toWarehouse ? {
      id: c.toWarehouse.id,
      name: c.toWarehouse.name,
      type: c.toWarehouse.type,
      outletId: c.toWarehouse.outletId ?? null,
    } : null,
    dispatchedAt: c.dispatchedAt,
    receivedAt: c.receivedAt,
    dispatchedBy: c.dispatchedBy ? { id: c.dispatchedBy.id, name: c.dispatchedBy.name } : null,
    receivedBy:   c.receivedBy   ? { id: c.receivedBy.id,   name: c.receivedBy.name   } : null,
    createdBy:    c.createdBy    ? { id: c.createdBy.id,    name: c.createdBy.name    } : null,
    createdAt: c.createdAt,
    items: c.items.map((i: any) => ({
      id: i.id,
      ingredientId: i.ingredientId,
      ingredientName: i.ingredient.name,
      unit: i.ingredient.unit?.symbol || i.ingredient.unit?.name || '—',
      qty: Number(i.qty),
      receivedQty: i.receivedQty ? Number(i.receivedQty) : null,
    })),
  };
}

// Resolve warehouse IDs visible to a non-admin user
async function getUserScopeWhIds(outletId: string | null | undefined): Promise<string[]> {
  if (outletId) {
    const whs = await prisma.warehouse.findMany({ where: { outletId }, select: { id: true } });
    return whs.map(w => w.id);
  }
  // No outletId → main-warehouse staff; scope to MAIN type warehouses
  const whs = await prisma.warehouse.findMany({ where: { type: 'MAIN' }, select: { id: true } });
  return whs.map(w => w.id);
}

export const getChallans = asyncHandler(async (req: Request, res: Response) => {
  const { status, fromWarehouseId, toWarehouseId } = req.query as Record<string, string>;

  const where: any = {};
  if (status)           where.status           = status;
  if (fromWarehouseId)  where.fromWarehouseId  = fromWarehouseId;
  if (toWarehouseId)    where.toWarehouseId    = toWarehouseId;

  // W6: Outlet-scoped filtering for non-admin users
  if (!ADMIN_ROLES.includes(req.user?.role || '')) {
    const whIds = await getUserScopeWhIds(req.user?.outletId);
    if (whIds.length === 0) {
      return res.json(ApiResponse.success([]));
    }
    where.OR = [
      { fromWarehouseId: { in: whIds } },
      { toWarehouseId:   { in: whIds } },
    ];
  }

  const data = await prisma.stockChallan.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    include: CHALLAN_INCLUDE,
  });

  return res.json(ApiResponse.success(data.map(mapChallan)));
});

export const getChallan = asyncHandler(async (req: Request, res: Response) => {
  const c = await prisma.stockChallan.findUnique({
    where: { id: req.params.id },
    include: CHALLAN_INCLUDE,
  });
  if (!c) throw new ApiError('Challan not found', 404);
  return res.json(ApiResponse.success(mapChallan(c)));
});

export const createChallan = asyncHandler(async (req: Request, res: Response) => {
  const { fromWarehouseId, toWarehouseId, notes, items } = req.body;

  if (!fromWarehouseId) throw new ApiError('From warehouse is required', 400);
  if (!toWarehouseId)   throw new ApiError('To warehouse is required', 400);
  if (fromWarehouseId === toWarehouseId) throw new ApiError('From and to warehouses must be different', 400);
  if (!items || !Array.isArray(items) || items.length === 0) throw new ApiError('Items are required', 400);

  for (const item of items) {
    if (!item.ingredientId)        throw new ApiError('Ingredient ID is required for each item', 400);
    if (Number(item.qty) <= 0)     throw new ApiError('Quantity must be greater than 0', 400);
  }

  // W6: Validate warehouse type pair — only MAIN→BRANCH and BRANCH→KITCHEN are allowed
  const [fromWH, toWH] = await Promise.all([
    prisma.warehouse.findUnique({ where: { id: fromWarehouseId }, select: { id: true, type: true, name: true, outletId: true } }),
    prisma.warehouse.findUnique({ where: { id: toWarehouseId },   select: { id: true, type: true, name: true, outletId: true } }),
  ]);
  if (!fromWH) throw new ApiError('From warehouse not found', 404);
  if (!toWH)   throw new ApiError('To warehouse not found', 404);

  const VALID_PAIRS: Record<string, string> = { MAIN: 'BRANCH', BRANCH: 'KITCHEN' };
  const expectedToType = VALID_PAIRS[fromWH.type];
  if (!expectedToType) {
    throw new ApiError(`${fromWH.type} warehouse cannot be a transfer source`, 400);
  }
  if (toWH.type !== expectedToType) {
    throw new ApiError(`${fromWH.type} → ${toWH.type} is not allowed. ${fromWH.type} can only transfer to ${expectedToType}`, 400);
  }
  // BRANCH → KITCHEN: must be the same outlet
  if (fromWH.type === 'BRANCH' && fromWH.outletId !== toWH.outletId) {
    throw new ApiError('Branch can only transfer to its own outlet\'s kitchen', 400);
  }

  // Auto-generate challan number: CHN-YYYYMMDD-XXXX
  const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const count = await prisma.stockChallan.count({
    where: { challanNo: { startsWith: `CHN-${today}` } },
  });
  const challanNo = `CHN-${today}-${String(count + 1).padStart(4, '0')}`;

  const challan = await prisma.stockChallan.create({
    data: {
      challanNo,
      fromWarehouseId,
      toWarehouseId,
      notes: notes || null,
      createdById: req.user?.id || null,
      items: {
        create: items.map((item: any) => ({
          ingredientId: item.ingredientId,
          qty: item.qty,
        })),
      },
    },
    include: CHALLAN_INCLUDE,
  });

  return res.status(201).json(ApiResponse.created(mapChallan(challan), 'Challan created'));
});

export const dispatchChallan = asyncHandler(async (req: Request, res: Response) => {
  const challan = await prisma.stockChallan.findUnique({ where: { id: req.params.id } });
  if (!challan) throw new ApiError('Challan not found', 404);
  if (challan.status !== 'PENDING') throw new ApiError('Only pending challans can be dispatched', 400);

  const updated = await prisma.$transaction(async (tx) => {
    const items = await tx.stockChallanItem.findMany({
      where: { challanId: challan.id },
      include: { ingredient: true },
    });

    for (const item of items) {
      const ws = await tx.warehouseStock.findUnique({
        where: { warehouseId_ingredientId: { warehouseId: challan.fromWarehouseId, ingredientId: item.ingredientId } },
      });
      const availableStock = ws ? Number(ws.currentStock) : 0;
      if (availableStock < Number(item.qty)) {
        throw new ApiError(
          `Insufficient stock: ${item.ingredient.name} (available: ${availableStock}, required: ${Number(item.qty)})`,
          400
        );
      }
      await tx.warehouseStock.update({
        where: { warehouseId_ingredientId: { warehouseId: challan.fromWarehouseId, ingredientId: item.ingredientId } },
        data: { currentStock: { decrement: Number(item.qty) } },
      });
    }

    return tx.stockChallan.update({
      where: { id: challan.id },
      data: { status: 'DISPATCHED', dispatchedAt: new Date(), dispatchedById: req.user?.id || null },
      include: CHALLAN_INCLUDE,
    });
  }, { timeout: 30000 });

  return res.json(ApiResponse.success(mapChallan(updated), 'Challan dispatched'));
});

export const receiveChallan = asyncHandler(async (req: Request, res: Response) => {
  const challan = await prisma.stockChallan.findUnique({ where: { id: req.params.id } });
  if (!challan) throw new ApiError('Challan not found', 404);
  if (challan.status !== 'DISPATCHED') throw new ApiError('Only dispatched challans can be received', 400);

  const { items: itemsInput } = req.body || {};

  const updated = await prisma.$transaction(async (tx) => {
    const items = await tx.stockChallanItem.findMany({ where: { challanId: challan.id } });

    for (const item of items) {
      const receivedQty = itemsInput?.find((i: any) => i.id === item.id)?.receivedQty ?? item.qty;
      const ing = await tx.ingredient.findUnique({ where: { id: item.ingredientId }, select: { lowStockLevel: true } });
      await tx.warehouseStock.upsert({
        where: { warehouseId_ingredientId: { warehouseId: challan.toWarehouseId, ingredientId: item.ingredientId } },
        update: { currentStock: { increment: Number(receivedQty) } },
        create: { warehouseId: challan.toWarehouseId, ingredientId: item.ingredientId, currentStock: Number(receivedQty), lowStockLevel: Number(ing?.lowStockLevel ?? 0) },
      });
      if (receivedQty !== item.qty) {
        await tx.stockChallanItem.update({ where: { id: item.id }, data: { receivedQty } });
      }
    }

    return tx.stockChallan.update({
      where: { id: challan.id },
      data: { status: 'RECEIVED', receivedAt: new Date(), receivedById: req.user?.id || null },
      include: CHALLAN_INCLUDE,
    });
  }, { timeout: 30000 });

  return res.json(ApiResponse.success(mapChallan(updated), 'Challan received'));
});

export const cancelChallan = asyncHandler(async (req: Request, res: Response) => {
  const challan = await prisma.stockChallan.findUnique({ where: { id: req.params.id } });
  if (!challan) throw new ApiError('Challan not found', 404);
  if (challan.status !== 'PENDING' && challan.status !== 'DISPATCHED') {
    throw new ApiError('Only pending or dispatched challans can be cancelled', 400);
  }

  const updated = await prisma.$transaction(async (tx) => {
    if (challan.status === 'DISPATCHED') {
      const items = await tx.stockChallanItem.findMany({ where: { challanId: challan.id } });
      for (const item of items) {
        await tx.warehouseStock.update({
          where: { warehouseId_ingredientId: { warehouseId: challan.fromWarehouseId, ingredientId: item.ingredientId } },
          data: { currentStock: { increment: Number(item.qty) } },
        });
      }
    }
    return tx.stockChallan.update({
      where: { id: challan.id },
      data: { status: 'CANCELLED' },
      include: CHALLAN_INCLUDE,
    });
  }, { timeout: 30000 });

  return res.json(ApiResponse.success(mapChallan(updated), 'Challan cancelled'));
});
