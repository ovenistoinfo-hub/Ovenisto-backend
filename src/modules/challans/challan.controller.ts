/**
 * Stock Challan Controller — Phase W3 / W6
 */
import type { Request, Response } from 'express';
import { prisma } from '../../config/database.js';
import { ApiResponse } from '../../utils/ApiResponse.js';
import { ApiError } from '../../utils/ApiError.js';
import { asyncHandler } from '../../utils/asyncHandler.js';
import { USER_SELECT, mapUser } from '../../utils/userHelpers.js';
import { resolveOutletScope } from '../../middleware/outletScope.js';
import { computeChallanSettlement } from './challan.helpers.js';
import { getChallanScopeFilter } from '../warehouse/warehouse.access.js';
import { emitChallanEvent } from '../../socket.js';

// B4b: throw 404 if the acting outlet owns neither warehouse of this challan.
// scope === null (admins, central main-warehouse staff) → no restriction.
function assertChallanInScope(
  req: Request,
  fromOutletId: string | null | undefined,
  toOutletId: string | null | undefined,
): void {
  const scope = resolveOutletScope(req);
  if (scope && fromOutletId !== scope && toOutletId !== scope) {
    throw new ApiError('Challan not found', 404);
  }
}

// Shared include block — add outletId to warehouse selects (W6)
const CHALLAN_INCLUDE = {
  fromWarehouse: { select: { id: true, name: true, type: true, outletId: true } },
  toWarehouse:   { select: { id: true, name: true, type: true, outletId: true } },
  items: {
    include: {
      ingredient: { select: { id: true, name: true, purchasePrice: true, unit: { select: { symbol: true, name: true } }, category: { select: { name: true } } } },
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
    tax:          c.tax          !== null && c.tax          !== undefined ? Number(c.tax)          : null,
    subtotal:     c.subtotal     !== null && c.subtotal     !== undefined ? Number(c.subtotal)     : null,
    total:        c.total        !== null && c.total        !== undefined ? Number(c.total)        : null,
    paid: Number(c.paid ?? 0),
    due:  Number(c.due ?? 0),
    paymentStatus: c.paymentStatus ?? null,
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
      unitPrice: i.unitPrice !== null && i.unitPrice !== undefined ? Number(i.unitPrice) : null,
      purchasePrice: i.ingredient.purchasePrice !== null ? Number(i.ingredient.purchasePrice) : 0,
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

export const getChallans = asyncHandler(async (req: Request, res: Response) => {
  const { status, fromWarehouseId, toWarehouseId, page, limit } = req.query as Record<string, string>;

  const where: any = {};
  if (status)           where.status           = status;
  if (fromWarehouseId)  where.fromWarehouseId  = fromWarehouseId;
  if (toWarehouseId)    where.toWarehouseId    = toWarehouseId;

  // Role-based and user-wise outlet scoping
  const scope = resolveOutletScope(req);
  const scopeFilter = getChallanScopeFilter(req.user?.role, scope);
  Object.assign(where, scopeFilter);

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
  assertChallanInScope(req, c.fromWarehouse?.outletId, c.toWarehouse?.outletId);
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

  // Role-specific transfer validation
  if (req.user?.role === 'Super Admin') {
    if (fromWH.type !== 'MAIN' || toWH.type !== 'BRANCH') {
      throw new ApiError('Super Admin can only create transfers from Main Warehouse to Branch Warehouses', 403);
    }
    const scope = resolveOutletScope(req);
    if (scope && toWH.outletId !== scope) {
      throw new ApiError('Destination warehouse is not in the selected outlet', 403);
    }
  } else {
    if (fromWH.type !== 'BRANCH' || toWH.type !== 'KITCHEN') {
      throw new ApiError('Branch-scoped users can only create transfers from Branch to Kitchen Warehouses', 403);
    }
    const scope = resolveOutletScope(req);
    if (scope) {
      if (fromWH.outletId !== scope || toWH.outletId !== scope) {
        throw new ApiError('Both source and destination warehouses must belong to your outlet', 403);
      }
    }
  }

  // Auto-generate challan number: CHN-YYYYMMDD-XXXX
  const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const count = await prisma.stockChallan.count({
    where: { challanNo: { startsWith: `CHN-${today}` } },
  });
  const challanNo = `CHN-${today}-${String(count + 1).padStart(4, '0')}`;

  const ingredientIds = items.map((item: any) => item.ingredientId);
  const ingredients = await prisma.ingredient.findMany({
    where: { id: { in: ingredientIds } },
    select: { id: true, purchasePrice: true }
  });
  const priceMap = new Map(ingredients.map(ig => [ig.id, Number(ig.purchasePrice || 0)]));

  const subtotal = items.reduce((sum: number, item: any) => {
    const price = priceMap.get(item.ingredientId) ?? 0;
    return sum + Number(item.qty) * price;
  }, 0);

  const total = subtotal + (Number(shippingCost) || 0) + (Number(miscAmount) || 0);

  const challan = await prisma.stockChallan.create({
    data: {
      challanNo,
      fromWarehouseId,
      toWarehouseId,
      notes: notes || null,
      shippingCost: shippingCost != null ? Number(shippingCost) : null,
      miscAmount:   miscAmount   != null ? Number(miscAmount)   : null,
      subtotal: subtotal,
      total: total,
      createdById: req.user?.id || null,
      items: {
        create: items.map((item: any) => ({
          ingredientId: item.ingredientId,
          qty: item.qty,
          unitPrice: priceMap.get(item.ingredientId) ?? 0,
        })),
      },
    },
    include: CHALLAN_INCLUDE,
  });

  const created = mapChallan(challan);
  emitChallanEvent('challan:created', created, [fromWH.outletId, toWH.outletId]);
  return res.status(201).json(ApiResponse.created(created, 'Challan created'));
});

export const dispatchChallan = asyncHandler(async (req: Request, res: Response) => {
  const challan = await prisma.stockChallan.findUnique({
    where: { id: req.params.id },
    include: {
      fromWarehouse: { select: { outletId: true } },
      toWarehouse:   { select: { outletId: true } },
    },
  });
  if (!challan) throw new ApiError('Challan not found', 404);
  assertChallanInScope(req, challan.fromWarehouse?.outletId, challan.toWarehouse?.outletId);
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

  const dispatched = mapChallan(updated);
  emitChallanEvent('challan:updated', dispatched, [
    challan.fromWarehouse?.outletId,
    challan.toWarehouse?.outletId,
  ]);
  return res.json(ApiResponse.success(dispatched, 'Challan dispatched'));
});

export const receiveChallan = asyncHandler(async (req: Request, res: Response) => {
  const challan = await prisma.stockChallan.findUnique({
    where: { id: req.params.id },
    include: {
      fromWarehouse: { select: { outletId: true, type: true } },
      toWarehouse:   { select: { outletId: true, type: true } },
    },
  });
  if (!challan) throw new ApiError('Challan not found', 404);
  // B4b: unified strict-endpoint outlet guard — runs first so a cross-outlet
  // caller always gets a uniform 404 (never a status-revealing 400/403),
  // matching the other by-id handlers.
  assertChallanInScope(req, challan.fromWarehouse?.outletId, challan.toWarehouse?.outletId);
  if (challan.status !== 'DISPATCHED') throw new ApiError('Only dispatched challans can be received', 400);

  // Super Admin dispatches, does not receive
  if (req.user?.role === 'Super Admin') {
    throw new ApiError('Super Admin cannot receive challans — branch/kitchen staff must confirm receipt', 403);
  }

  const { items: itemsInput, shippingCost: shipIn, miscAmount: miscIn, tax: taxIn, paid: paidIn } = req.body || {};
  const isMainToBranch = challan.fromWarehouse?.type === 'MAIN';

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

  const itemIngredientIds = items.map(i => i.ingredientId);

  // 1. Fetch ingredients lowStockLevel and purchasePrice outside transaction
  const ingredientsData = await prisma.ingredient.findMany({
    where: { id: { in: itemIngredientIds } },
    select: { id: true, lowStockLevel: true, purchasePrice: true },
  });
  const ingredientMap = new Map(ingredientsData.map(ig => [ig.id, ig]));

  // 2. Fetch source warehouse batches outside transaction
  const sourceBatches = await prisma.stockBatch.findMany({
    where: { warehouseId: challan.fromWarehouseId, ingredientId: { in: itemIngredientIds } },
    orderBy: [{ expiryDate: { sort: 'asc', nulls: 'last' } }, { createdAt: 'asc' }],
  });
  const batchesByIngredient = new Map<string, typeof sourceBatches>();
  for (const batch of sourceBatches) {
    if (!batchesByIngredient.has(batch.ingredientId)) {
      batchesByIngredient.set(batch.ingredientId, []);
    }
    batchesByIngredient.get(batch.ingredientId)!.push(batch);
  }

  const settlementItems: { qty: number; unitPrice: number }[] = [];

  const updated = await prisma.$transaction(async (tx) => {
    for (const item of items) {
      const input = itemsInput?.find((i: any) => i.id === item.id);
      const receivedQty = Number(input?.receivedQty ?? item.qty);
      const wasteQty = Number(input?.wasteQty ?? 0);
      const wasteReason = input?.wasteReason ?? null;
      const actualReceived = receivedQty - wasteQty; // net qty added to stock

      const ing = ingredientMap.get(item.ingredientId);
      const unitPrice = isMainToBranch ? Number(ing?.purchasePrice ?? 0) : null;
      if (isMainToBranch) settlementItems.push({ qty: Number(item.qty), unitPrice: unitPrice ?? 0 });

      // Update destination warehouse stock with net received (minus waste)
      if (actualReceived > 0) {
        await tx.warehouseStock.upsert({
          where: { warehouseId_ingredientId: { warehouseId: challan.toWarehouseId, ingredientId: item.ingredientId } },
          update: { currentStock: { increment: actualReceived } },
          create: { warehouseId: challan.toWarehouseId, ingredientId: item.ingredientId, currentStock: actualReceived, lowStockLevel: Number(ing?.lowStockLevel ?? 0) },
        });
      }

      // Update challan item with received qty, waste qty, waste reason (+ price snapshot for MAIN→BRANCH)
      await tx.stockChallanItem.update({
        where: { id: item.id },
        data: { receivedQty, wasteQty: wasteQty || null, wasteReason, ...(isMainToBranch && { unitPrice }) },
      });

      // Create batches in destination warehouse (FIFO from source, using actualReceived not full receivedQty)
      if (actualReceived > 0) {
        const ingredientBatches = batchesByIngredient.get(item.ingredientId) ?? [];

        let qtyToAllocate = actualReceived;
        for (const srcBatch of ingredientBatches) {
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

    const effectiveShipping = shipIn !== undefined ? (Number(shipIn) || 0) : Number(challan.shippingCost ?? 0);
    const effectiveMisc     = miscIn !== undefined ? (Number(miscIn) || 0) : Number(challan.miscAmount ?? 0);
    const effectiveTax      = taxIn  !== undefined ? (Number(taxIn)  || 0) : Number(challan.tax ?? 0);
    const paidAmount = Number(paidIn) || 0;

    const settlement = isMainToBranch
      ? computeChallanSettlement({
          items: settlementItems,
          tax: effectiveTax,
          shippingCost: effectiveShipping,
          miscAmount: effectiveMisc,
          paid: paidAmount,
        })
      : null;

    // Guard BEFORE any write: if this is a MAIN→BRANCH settlement that owes
    // money but the receiving warehouse has no outlet, the ledger-charge block
    // below (Outlet.dueToMain increment + WarehouseSettlement CHARGE row) would
    // be skipped while stockChallan.update below still marks the challan
    // RECEIVED with due>0 — money silently vanishes from the ledger. Throwing
    // here aborts the whole $transaction atomically, before any write happens.
    if (isMainToBranch && settlement && settlement.due > 0 && !challan.toWarehouse?.outletId) {
      throw new ApiError('Cannot settle transfer: receiving warehouse has no outlet assigned', 500);
    }

    const result = await tx.stockChallan.update({
      where: { id: challan.id },
      data: {
        status: 'RECEIVED',
        receivedAt: new Date(),
        receivedById: req.user?.id || null,
        ...(shipIn !== undefined && { shippingCost: Number(shipIn) || null }),
        ...(miscIn !== undefined && { miscAmount: Number(miscIn) || null }),
        ...(isMainToBranch && settlement && {
          tax: effectiveTax,
          subtotal: settlement.subtotal,
          total: settlement.total,
          paid: paidAmount,
          due: settlement.due,
          paymentStatus: settlement.paymentStatus,
        }),
      },
      include: CHALLAN_INCLUDE,
    });

    // Update linked demand status to FULFILLED
    await tx.stockDemand.updateMany({
      where: { challanId: challan.id },
      data: {
        status: 'FULFILLED',
        fulfilledAt: new Date(),
      },
    });

    if (isMainToBranch && settlement && settlement.due > 0 && challan.toWarehouse?.outletId) {
      const updatedOutlet = await tx.outlet.update({
        where: { id: challan.toWarehouse.outletId },
        data: { dueToMain: { increment: settlement.due } },
      });
      await tx.warehouseSettlement.create({
        data: {
          outletId: challan.toWarehouse.outletId,
          type: 'CHARGE',
          amount: settlement.due,
          balanceAfter: updatedOutlet.dueToMain,
          challanId: challan.id,
          recordedById: req.user?.id || null,
        },
      });
    }

    return result;
  }, { timeout: 60000 });

  const received = mapChallan(updated);
  emitChallanEvent('challan:updated', received, [
    challan.fromWarehouse?.outletId,
    challan.toWarehouse?.outletId,
  ]);
  return res.json(ApiResponse.success(received, 'Challan received'));
});

export const cancelChallan = asyncHandler(async (req: Request, res: Response) => {
  const challan = await prisma.stockChallan.findUnique({
    where: { id: req.params.id },
    include: {
      fromWarehouse: { select: { outletId: true } },
      toWarehouse:   { select: { outletId: true } },
    },
  });
  if (!challan) throw new ApiError('Challan not found', 404);
  assertChallanInScope(req, challan.fromWarehouse?.outletId, challan.toWarehouse?.outletId);
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

  const cancelled = mapChallan(updated);
  emitChallanEvent('challan:updated', cancelled, [
    challan.fromWarehouse?.outletId,
    challan.toWarehouse?.outletId,
  ]);
  return res.json(ApiResponse.success(cancelled, 'Challan cancelled'));
});

export const getChallanStats = asyncHandler(async (req: Request, res: Response) => {
  const { fromWarehouseId, toWarehouseId } = req.query as Record<string, string>;

  const where: any = {
    status: { in: ['DISPATCHED', 'RECEIVED'] }
  };
  if (fromWarehouseId) where.fromWarehouseId = fromWarehouseId;
  if (toWarehouseId)   where.toWarehouseId   = toWarehouseId;

  const scope = resolveOutletScope(req);
  if (scope) {
    where.OR = [
      { fromWarehouse: { outletId: scope } },
      { toWarehouse:   { outletId: scope } },
    ];
  }

  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  
  const startOfWeek = new Date(now);
  startOfWeek.setDate(now.getDate() - ((now.getDay() + 6) % 7));
  const weekStart = new Date(startOfWeek.getFullYear(), startOfWeek.getMonth(), startOfWeek.getDate());

  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

  const [totalAgg, todayAgg, weeklyAgg, monthlyAgg] = await Promise.all([
    prisma.stockChallan.aggregate({
      where,
      _sum: { total: true },
    }),
    prisma.stockChallan.aggregate({
      where: {
        ...where,
        createdAt: { gte: todayStart },
      },
      _sum: { total: true },
    }),
    prisma.stockChallan.aggregate({
      where: {
        ...where,
        createdAt: { gte: weekStart },
      },
      _sum: { total: true },
    }),
    prisma.stockChallan.aggregate({
      where: {
        ...where,
        createdAt: { gte: monthStart },
      },
      _sum: { total: true },
    }),
  ]);

  return res.json(ApiResponse.success({
    total: Number(totalAgg._sum.total || 0),
    today: Number(todayAgg._sum.total || 0),
    weekly: Number(weeklyAgg._sum.total || 0),
    monthly: Number(monthlyAgg._sum.total || 0),
  }));
});
