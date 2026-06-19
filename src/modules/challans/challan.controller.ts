/**
 * Stock Challan Controller — Phase W3 / W6
 */
import type { Request, Response } from 'express';
import { prisma } from '../../config/database.js';
import { ApiResponse } from '../../utils/ApiResponse.js';
import { ApiError } from '../../utils/ApiError.js';
import { asyncHandler } from '../../utils/asyncHandler.js';
import { USER_SELECT, mapUser } from '../../utils/userHelpers.js';

const ADMIN_ROLES = ['Super Admin', 'Admin'];

// Shared include block — add outletId to warehouse selects (W6)
const CHALLAN_INCLUDE = {
  fromWarehouse: { select: { id: true, name: true, type: true, outletId: true } },
  toWarehouse:   { select: { id: true, name: true, type: true, outletId: true } },
  items: {
    include: {
      ingredient: { select: { id: true, name: true, unit: { select: { symbol: true, name: true } }, category: { select: { name: true } } } },
    },
  },
  dispatchedBy: { select: USER_SELECT },
  receivedBy:   { select: USER_SELECT },
  createdBy:    { select: USER_SELECT },
  demand: {
    include: {
      requestingWH: { select: { id: true, name: true, type: true } },
      supplyingWH:  { select: { id: true, name: true, type: true } },
      requestedBy:  { select: USER_SELECT },
      approvedBy:   { select: USER_SELECT },
      items: {
        include: {
          ingredient: { select: { id: true, name: true, unit: { select: { symbol: true, name: true } }, category: { select: { name: true } } } },
        },
      },
    },
  },
};

function mapChallan(c: any) {
  return {
    id: c.id,
    challanNo: c.challanNo,
    status: c.status,
    notes: c.notes,
    shippingCost: c.shippingCost !== null && c.shippingCost !== undefined ? Number(c.shippingCost) : null,
    miscAmount:   c.miscAmount   !== null && c.miscAmount   !== undefined ? Number(c.miscAmount)   : null,
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
    dispatchedBy: mapUser(c.dispatchedBy),
    receivedBy:   mapUser(c.receivedBy),
    createdBy:    mapUser(c.createdBy),
    createdAt: c.createdAt,
    items: c.items.map((i: any) => ({
      id: i.id,
      ingredientId: i.ingredientId,
      ingredientName: i.ingredient.name,
      category: i.ingredient.category?.name ?? null,
      unit: i.ingredient.unit?.symbol || i.ingredient.unit?.name || '—',
      qty: Number(i.qty),
      receivedQty: i.receivedQty !== null && i.receivedQty !== undefined ? Number(i.receivedQty) : null,
      wasteQty: i.wasteQty !== null && i.wasteQty !== undefined ? Number(i.wasteQty) : null,
      wasteReason: i.wasteReason ?? null,
    })),
    demand: c.demand ? {
      id: c.demand.id,
      demandNo: c.demand.demandNo,
      status: c.demand.status,
      notes: c.demand.notes ?? null,
      rejectionReason: c.demand.rejectionReason ?? null,
      requestingWH: c.demand.requestingWH ? { id: c.demand.requestingWH.id, name: c.demand.requestingWH.name, type: c.demand.requestingWH.type } : null,
      supplyingWH:  c.demand.supplyingWH  ? { id: c.demand.supplyingWH.id,  name: c.demand.supplyingWH.name,  type: c.demand.supplyingWH.type  } : null,
      requestedBy:  mapUser(c.demand.requestedBy),
      approvedBy:   mapUser(c.demand.approvedBy),
      approvedAt: c.demand.approvedAt ?? null,
      createdAt:  c.demand.createdAt,
      items: c.demand.items.map((i: any) => ({
        id: i.id,
        ingredientId: i.ingredientId,
        ingredientName: i.ingredient.name,
        category: i.ingredient.category?.name ?? null,
        unit: i.ingredient.unit?.symbol || i.ingredient.unit?.name || '—',
        requestedQty: Number(i.requestedQty),
        approvedQty: i.approvedQty !== null ? Number(i.approvedQty) : null,
        stockAtRequest: i.stockAtRequest !== null && i.stockAtRequest !== undefined ? Number(i.stockAtRequest) : null,
      })),
    } : null,
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
  const { status, fromWarehouseId, toWarehouseId, page, limit } = req.query as Record<string, string>;

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

  // OPT-IN pagination (perf #8): paginate only when `limit` is explicitly present.
  // Without `limit` the response is byte-identical to before — a top-level `data`
  // array of mapped challans.
  //
  // NOTE on the include: the perf audit suggested trimming the nested
  // `demand.items` graph from the LIST include. We deliberately did NOT do that.
  // The frontend Transfers page opens the detail dialog and the print/document
  // view directly from the list row object (`setShowDetail(c)` — no per-id
  // re-fetch), and that dialog renders `demand.items` (item table, item count,
  // print). Dropping `demand.items` here would break those views, so we keep the
  // full CHALLAN_INCLUDE for the list. Pagination alone bounds the payload safely.
  const limitNum = limit !== undefined ? Math.max(1, Number(limit)) : undefined;
  const pageNum = page !== undefined ? Math.max(1, Number(page)) : 1;

  if (limitNum !== undefined) {
    const [data, total] = await Promise.all([
      prisma.stockChallan.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        include: CHALLAN_INCLUDE,
        skip: (pageNum - 1) * limitNum,
        take: limitNum,
      }),
      prisma.stockChallan.count({ where }),
    ]);
    return res.json(ApiResponse.paginated(data.map(mapChallan), pageNum, limitNum, total));
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
  const { fromWarehouseId, toWarehouseId, notes, items, shippingCost, miscAmount } = req.body;

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
      shippingCost: shippingCost != null ? shippingCost : null,
      miscAmount:   miscAmount   != null ? miscAmount   : null,
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

  // Pre-transaction: load items and validate stock availability (avoids transaction timeout on Neon)
  const items = await prisma.stockChallanItem.findMany({
    where: { challanId: challan.id },
    include: { ingredient: true },
  });

  // Batch stock validation
  const dispatchIngIds = items.filter(i => Number(i.qty) > 0).map(i => i.ingredientId);
  const stockRecords = await prisma.warehouseStock.findMany({
    where: { warehouseId: challan.fromWarehouseId, ingredientId: { in: dispatchIngIds } },
  });
  const stockMap = new Map(stockRecords.map(ws => [ws.ingredientId, Number(ws.currentStock)]));
  for (const item of items) {
    const qty = Number(item.qty);
    if (qty <= 0) continue;
    const availableStock = stockMap.get(item.ingredientId) ?? 0;
    if (availableStock < qty) {
      throw new ApiError(
        `Insufficient stock: ${item.ingredient.name} (available: ${availableStock}, required: ${qty})`,
        400
      );
    }
  }

  // Transaction: deduct stock + update batches + mark dispatched
  const updated = await prisma.$transaction(async (tx) => {
    for (const item of items) {
      const qty = Number(item.qty);
      if (qty <= 0) continue;

      // Deduct from warehouse stock
      await tx.warehouseStock.update({
        where: { warehouseId_ingredientId: { warehouseId: challan.fromWarehouseId, ingredientId: item.ingredientId } },
        data: { currentStock: { decrement: qty } },
      });

      // FIFO: Deduct from earliest-expiry batches first in source warehouse
      const batches = await tx.stockBatch.findMany({
        where: { warehouseId: challan.fromWarehouseId, ingredientId: item.ingredientId, remainingQty: { gt: 0 } },
        orderBy: [{ expiryDate: { sort: 'asc', nulls: 'last' } }, { createdAt: 'asc' }],
      });

      let qtyToDeduct = qty;
      for (const batch of batches) {
        if (qtyToDeduct <= 0) break;
        const batchRemaining = Number(batch.remainingQty);
        const deductFromBatch = Math.min(batchRemaining, qtyToDeduct);
        await tx.stockBatch.update({
          where: { id: batch.id },
          data: { remainingQty: { decrement: deductFromBatch } },
        });
        qtyToDeduct -= deductFromBatch;
      }
    }

    return tx.stockChallan.update({
      where: { id: challan.id },
      data: { status: 'DISPATCHED', dispatchedAt: new Date(), dispatchedById: req.user?.id || null },
      include: CHALLAN_INCLUDE,
    });
  }, { timeout: 60000 });

  return res.json(ApiResponse.success(mapChallan(updated), 'Challan dispatched'));
});

export const receiveChallan = asyncHandler(async (req: Request, res: Response) => {
  const challan = await prisma.stockChallan.findUnique({
    where: { id: req.params.id },
    include: { toWarehouse: { select: { outletId: true, type: true } } },
  });
  if (!challan) throw new ApiError('Challan not found', 404);
  if (challan.status !== 'DISPATCHED') throw new ApiError('Only dispatched challans can be received', 400);

  // Super Admin dispatches, does not receive
  if (req.user?.role === 'Super Admin') {
    throw new ApiError('Super Admin cannot receive challans — branch/kitchen staff must confirm receipt', 403);
  }

  // Non-admin users must belong to the destination warehouse's outlet
  const destOutlet = (challan as any).toWarehouse?.outletId;
  if (!ADMIN_ROLES.includes(req.user?.role ?? '') && req.user?.outletId && destOutlet && req.user.outletId !== destOutlet) {
    throw new ApiError('You can only receive challans destined to your outlet', 403);
  }

  const { items: itemsInput, shippingCost: shipIn, miscAmount: miscIn } = req.body || {};

  // Pre-transaction: load items with ingredient names for validation
  const items = await prisma.stockChallanItem.findMany({
    where: { challanId: challan.id },
    include: { ingredient: { select: { name: true } } },
  });

  // Validate waste quantities
  for (const item of items) {
    const input = itemsInput?.find((i: any) => i.id === item.id);
    if (input) {
      const receivedQty = Number(input.receivedQty ?? item.qty);
      const wasteQty = Number(input.wasteQty ?? 0);
      if (wasteQty > receivedQty) {
        throw new ApiError(`Waste quantity cannot exceed received quantity for "${item.ingredient.name}"`, 400);
      }
    }
  }

  const updated = await prisma.$transaction(async (tx) => {
    for (const item of items) {
      const input = itemsInput?.find((i: any) => i.id === item.id);
      const receivedQty = Number(input?.receivedQty ?? item.qty);
      const wasteQty = Number(input?.wasteQty ?? 0);
      const wasteReason = input?.wasteReason ?? null;
      const actualReceived = receivedQty - wasteQty; // net qty added to stock

      const ing = await tx.ingredient.findUnique({ where: { id: item.ingredientId }, select: { lowStockLevel: true } });

      // Update destination warehouse stock with net received (minus waste)
      if (actualReceived > 0) {
        await tx.warehouseStock.upsert({
          where: { warehouseId_ingredientId: { warehouseId: challan.toWarehouseId, ingredientId: item.ingredientId } },
          update: { currentStock: { increment: actualReceived } },
          create: { warehouseId: challan.toWarehouseId, ingredientId: item.ingredientId, currentStock: actualReceived, lowStockLevel: Number(ing?.lowStockLevel ?? 0) },
        });
      }

      // Update challan item with received qty, waste qty, waste reason
      await tx.stockChallanItem.update({
        where: { id: item.id },
        data: { receivedQty, wasteQty: wasteQty || null, wasteReason },
      });

      // Create batches in destination warehouse (FIFO from source, using actualReceived not full receivedQty)
      if (actualReceived > 0) {
        const sourceBatches = await tx.stockBatch.findMany({
          where: { warehouseId: challan.fromWarehouseId, ingredientId: item.ingredientId },
          orderBy: [{ expiryDate: { sort: 'asc', nulls: 'last' } }, { createdAt: 'asc' }],
        });

        let qtyToAllocate = actualReceived;
        for (const srcBatch of sourceBatches) {
          if (qtyToAllocate <= 0) break;
          const allocate = Math.min(Number(srcBatch.batchQty), qtyToAllocate);
          if (allocate <= 0) continue;
          await tx.stockBatch.create({
            data: {
              warehouseId: challan.toWarehouseId,
              ingredientId: item.ingredientId,
              batchQty: allocate,
              remainingQty: allocate,
              expiryDate: srcBatch.expiryDate,
            },
          });
          qtyToAllocate -= allocate;
        }

        if (qtyToAllocate > 0) {
          await tx.stockBatch.create({
            data: {
              warehouseId: challan.toWarehouseId,
              ingredientId: item.ingredientId,
              batchQty: qtyToAllocate,
              remainingQty: qtyToAllocate,
              expiryDate: null,
            },
          });
        }
      }
    }

    return tx.stockChallan.update({
      where: { id: challan.id },
      data: {
        status: 'RECEIVED',
        receivedAt: new Date(),
        receivedById: req.user?.id || null,
        ...(shipIn !== undefined && { shippingCost: Number(shipIn) || null }),
        ...(miscIn !== undefined && { miscAmount: Number(miscIn) || null }),
      },
      include: CHALLAN_INCLUDE,
    });
  }, { timeout: 60000 });

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
        // Restore warehouse stock
        await tx.warehouseStock.update({
          where: { warehouseId_ingredientId: { warehouseId: challan.fromWarehouseId, ingredientId: item.ingredientId } },
          data: { currentStock: { increment: Number(item.qty) } },
        });

        // Restore batch remainingQty (FIFO reverse — add back to earliest expiry batches)
        const batches = await tx.stockBatch.findMany({
          where: { warehouseId: challan.fromWarehouseId, ingredientId: item.ingredientId },
          orderBy: [{ expiryDate: { sort: 'asc', nulls: 'last' } }, { createdAt: 'asc' }],
        });
        let qtyToRestore = Number(item.qty);
        for (const batch of batches) {
          if (qtyToRestore <= 0) break;
          const canRestore = Math.min(Number(batch.batchQty) - Number(batch.remainingQty), qtyToRestore);
          if (canRestore > 0) {
            await tx.stockBatch.update({ where: { id: batch.id }, data: { remainingQty: { increment: canRestore } } });
            qtyToRestore -= canRestore;
          }
        }
      }
    }
    return tx.stockChallan.update({
      where: { id: challan.id },
      data: { status: 'CANCELLED' },
      include: CHALLAN_INCLUDE,
    });
  }, { timeout: 60000 });

  return res.json(ApiResponse.success(mapChallan(updated), 'Challan cancelled'));
});
