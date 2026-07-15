/**
 * Stock Demand Controller — Phase W4
 */
import type { Request, Response } from 'express';
import { prisma } from '../../config/database.js';
import { ApiResponse } from '../../utils/ApiResponse.js';
import { ApiError } from '../../utils/ApiError.js';
import { asyncHandler } from '../../utils/asyncHandler.js';
import { USER_SELECT, mapUser } from '../../utils/userHelpers.js';
import { resolveOutletScope } from '../../middleware/outletScope.js';
import { getDemandScopeFilter } from '../warehouse/warehouse.access.js';

function mapDemand(d: any) {
  return {
    id: d.id,
    demandNo: d.demandNo,
    status: d.status,
    notes: d.notes,
    rejectionReason: d.rejectionReason,
    challanId: d.challanId,
    requestingWH: d.requestingWH ? { id: d.requestingWH.id, name: d.requestingWH.name, type: d.requestingWH.type } : null,
    supplyingWH:  d.supplyingWH  ? { id: d.supplyingWH.id,  name: d.supplyingWH.name,  type: d.supplyingWH.type  } : null,
    requestedBy:  mapUser(d.requestedBy),
    approvedBy:   mapUser(d.approvedBy),
    approvedAt:  d.approvedAt,
    fulfilledAt: d.fulfilledAt,
    rejectedAt:  d.rejectedAt,
    createdAt:   d.createdAt,
    items: d.items.map((i: any) => ({
      id: i.id,
      ingredientId: i.ingredientId,
      ingredientName: i.ingredient.name,
      category: i.ingredient.category?.name ?? null,
      unit: i.ingredient.unit?.symbol || i.ingredient.unit?.name || '—',
      requestedQty: Number(i.requestedQty),
      approvedQty: i.approvedQty !== null ? Number(i.approvedQty) : null,
      stockAtRequest: i.stockAtRequest !== null && i.stockAtRequest !== undefined ? Number(i.stockAtRequest) : null,
    })),
  };
}

const INCLUDE = {
  requestingWH: { select: { id: true, name: true, type: true, outletId: true } },
  supplyingWH:  { select: { id: true, name: true, type: true, outletId: true } },
  requestedBy:  { select: USER_SELECT },
  approvedBy:   { select: USER_SELECT },
  items: {
    include: {
      ingredient: { select: { id: true, name: true, unit: { select: { symbol: true, name: true } }, category: { select: { name: true } } } },
    },
  },
};

// B4b: throw 404 if the acting outlet owns neither warehouse of this demand.
// scope === null (admins, central main-warehouse staff) → no restriction.
function assertDemandInScope(
  req: Request,
  reqOutletId: string | null | undefined,
  supOutletId: string | null | undefined,
): void {
  const scope = resolveOutletScope(req);
  if (scope && reqOutletId !== scope && supOutletId !== scope) {
    throw new ApiError('Demand not found', 404);
  }
}

export const getDemands = asyncHandler(async (req: Request, res: Response) => {
  const { status, requestingWHId, supplyingWHId, page, limit } = req.query as Record<string, string>;
  const where: any = {};
  if (status)          where.status          = status;
  if (requestingWHId)  where.requestingWHId  = requestingWHId;
  if (supplyingWHId)   where.supplyingWHId   = supplyingWHId;

  // Role-based and user-wise outlet scoping
  const scope = resolveOutletScope(req);
  const scopeFilter = getDemandScopeFilter(req.user?.role, scope);
  Object.assign(where, scopeFilter);

  // OPT-IN pagination (perf #8): paginate only when `limit` is explicitly present.
  // Without `limit` the response is byte-identical to before — a top-level `data`
  // array of mapped demands — so the Demands page (which reads the full list and
  // relies on each row's `items`) is unaffected. The deep `items.ingredient`
  // include is kept because the list view renders item counts and detail.
  const limitNum = limit !== undefined ? Math.max(1, Number(limit)) : undefined;
  const pageNum = page !== undefined ? Math.max(1, Number(page)) : 1;

  if (limitNum !== undefined) {
    const [data, total] = await Promise.all([
      prisma.stockDemand.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        include: INCLUDE,
        skip: (pageNum - 1) * limitNum,
        take: limitNum,
      }),
      prisma.stockDemand.count({ where }),
    ]);
    return res.json(ApiResponse.paginated(data.map(mapDemand), pageNum, limitNum, total));
  }

  const data = await prisma.stockDemand.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    include: INCLUDE,
  });
  return res.json(ApiResponse.success(data.map(mapDemand)));
});

export const getDemand = asyncHandler(async (req: Request, res: Response) => {
  const d = await prisma.stockDemand.findUnique({ where: { id: req.params.id }, include: INCLUDE });
  if (!d) throw new ApiError('Demand not found', 404);
  assertDemandInScope(req, d.requestingWH?.outletId, d.supplyingWH?.outletId);
  return res.json(ApiResponse.success(mapDemand(d)));
});

export const createDemand = asyncHandler(async (req: Request, res: Response) => {
  const { requestingWHId, supplyingWHId, notes, items } = req.body;
  if (!requestingWHId) throw new ApiError('Requesting warehouse is required', 400);
  if (!supplyingWHId)  throw new ApiError('Supplying warehouse is required', 400);
  if (requestingWHId === supplyingWHId) throw new ApiError('Requesting and supplying warehouses must be different', 400);
  if (!items || !Array.isArray(items) || items.length === 0) throw new ApiError('Items are required', 400);
  for (const item of items) {
    if (!item.ingredientId) throw new ApiError('Ingredient ID is required for each item', 400);
    if (Number(item.requestedQty) <= 0) throw new ApiError('Quantity must be greater than 0', 400);
  }

  // W6: Validate demand pair — KITCHEN requests from BRANCH (same outlet), BRANCH requests from MAIN
  const [reqWH, supWH] = await Promise.all([
    prisma.warehouse.findUnique({ where: { id: requestingWHId }, select: { id: true, type: true, outletId: true } }),
    prisma.warehouse.findUnique({ where: { id: supplyingWHId },  select: { id: true, type: true, outletId: true } }),
  ]);
  if (!reqWH) throw new ApiError('Requesting warehouse not found', 404);
  if (!supWH) throw new ApiError('Supplying warehouse not found', 404);

  // B4b: a scoped (non-admin) user may only raise a demand for their own
  // outlet's requesting warehouse. scope null (admins / central staff) → no check.
  const scope = resolveOutletScope(req);
  if (scope && reqWH.outletId !== scope) {
    throw new ApiError('Requesting warehouse is not in your outlet', 403);
  }

  // Role-specific demand checks
  if (req.user?.role === 'Kitchen Manager' && reqWH.type !== 'KITCHEN') {
    throw new ApiError('Kitchen Managers can only create demands originating from a Kitchen warehouse', 403);
  }
  if (req.user?.role === 'Store Manager' && reqWH.type !== 'BRANCH') {
    throw new ApiError('Store Managers can only create demands originating from a Branch warehouse', 403);
  }

  const VALID_DEMAND_PAIRS: Record<string, string> = { KITCHEN: 'BRANCH', BRANCH: 'MAIN' };
  const expectedSupplyType = VALID_DEMAND_PAIRS[reqWH.type];
  if (!expectedSupplyType) {
    throw new ApiError(`${reqWH.type} warehouse cannot create demands`, 400);
  }
  if (supWH.type !== expectedSupplyType) {
    throw new ApiError(`${reqWH.type} can only request from ${expectedSupplyType} warehouse`, 400);
  }
  // KITCHEN → BRANCH: must be same outlet
  if (reqWH.type === 'KITCHEN' && reqWH.outletId !== supWH.outletId) {
    throw new ApiError('Kitchen can only request from its own outlet\'s branch warehouse', 400);
  }

  const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const count = await prisma.stockDemand.count({ where: { demandNo: { startsWith: `DMD-${today}` } } });
  const demandNo = `DMD-${today}-${String(count + 1).padStart(4, '0')}`;

  // Snapshot current stock at time of request for each ingredient
  const ingredientIds = items.map((item: any) => item.ingredientId);
  const stockRows = await prisma.warehouseStock.findMany({
    where: { warehouseId: requestingWHId, ingredientId: { in: ingredientIds } },
    select: { ingredientId: true, currentStock: true },
  });
  const stockSnapshot: Record<string, number> = {};
  for (const row of stockRows) stockSnapshot[row.ingredientId] = Number(row.currentStock);

  const demand = await prisma.stockDemand.create({
    data: {
      demandNo,
      requestingWHId,
      supplyingWHId,
      notes: notes || null,
      requestedById: req.user?.id || null,
      items: {
        create: items.map((item: any) => ({
          ingredientId: item.ingredientId,
          requestedQty: item.requestedQty,
          stockAtRequest: stockSnapshot[item.ingredientId] ?? null,
        })),
      },
    },
    include: INCLUDE,
  });

  return res.status(201).json(ApiResponse.created(mapDemand(demand), 'Demand created'));
});

export const approveDemand = asyncHandler(async (req: Request, res: Response) => {
  const demand = await prisma.stockDemand.findUnique({
    where: { id: req.params.id },
    include: {
      items: true,
      requestingWH: { select: { type: true, outletId: true } },
      supplyingWH:  { select: { outletId: true } },
    },
  });
  if (!demand) throw new ApiError('Demand not found', 404);
  assertDemandInScope(req, demand.requestingWH?.outletId, demand.supplyingWH?.outletId);
  if (demand.status !== 'PENDING') throw new ApiError('Only pending demands can be approved', 400);

  // BRANCH→MAIN demands: only Super Admin can approve
  if (demand.requestingWH?.type === 'BRANCH' && req.user?.role !== 'Super Admin') {
    throw new ApiError('Only Super Admin can approve branch-to-main demands', 403);
  }
  // KITCHEN→BRANCH demands: Super Admin cannot approve (Manager/Admin handle these)
  if (demand.requestingWH?.type === 'KITCHEN' && req.user?.role === 'Super Admin') {
    throw new ApiError('Kitchen demands are handled by branch Manager/Admin, not Super Admin', 403);
  }

  const { items: itemsInput } = req.body || {};

  // Auto-generate challan number
  const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const count = await prisma.stockChallan.count({ where: { challanNo: { startsWith: `CHN-${today}` } } });
  const challanNo = `CHN-${today}-${String(count + 1).padStart(4, '0')}`;

  // Build challan items from approvedQty or requestedQty (pre-transaction)
  const challanItems = demand.items.map((i) => {
    const override = itemsInput?.find((x: any) => x.id === i.id);
    const qty = override?.approvedQty ?? Number(i.requestedQty);
    return { ingredientId: i.ingredientId, qty };
  }).filter((i) => Number(i.qty) > 0);

  if (challanItems.length === 0) throw new ApiError('At least one item must have approved qty > 0', 400);

  // Validate approved qty does not exceed available stock in supplying warehouse (batch query)
  const ingredientIds = challanItems.map(ci => ci.ingredientId);
  const stockRecords = await prisma.warehouseStock.findMany({
    where: { warehouseId: demand.supplyingWHId, ingredientId: { in: ingredientIds } },
    include: { ingredient: { select: { name: true } } },
  });
  const stockMap = new Map(stockRecords.map(ws => [ws.ingredientId, ws]));
  for (const ci of challanItems) {
    const ws = stockMap.get(ci.ingredientId);
    const available = ws ? Number(ws.currentStock) : 0;
    if (Number(ci.qty) > available) {
      throw new ApiError(
        `Cannot approve ${Number(ci.qty)} of ${ws?.ingredient?.name ?? 'item'} — only ${available} available in supplying warehouse`,
        400
      );
    }
  }

  const updated = await prisma.$transaction(async (tx) => {
    // Create challan (supplying WH → requesting WH)
    const challan = await tx.stockChallan.create({
      data: {
        challanNo,
        fromWarehouseId: demand.supplyingWHId,
        toWarehouseId:   demand.requestingWHId,
        notes: `Auto-created from demand ${demand.demandNo}`,
        createdById: req.user?.id || null,
        items: { create: challanItems },
      },
    });

    // Update demand item approvedQty values
    for (const i of demand.items) {
      const override = itemsInput?.find((x: any) => x.id === i.id);
      const approvedQty = override?.approvedQty ?? Number(i.requestedQty);
      await tx.stockDemandItem.update({ where: { id: i.id }, data: { approvedQty } });
    }

    // Update demand status
    const d = await tx.stockDemand.update({
      where: { id: demand.id },
      data: {
        status: 'APPROVED',
        challanId: challan.id,
        approvedAt: new Date(),
        approvedById: req.user?.id || null,
      },
      include: INCLUDE,
    });

    return { d, challanNo };
  }, { timeout: 60000 });

  return res.json(ApiResponse.success(
    { ...mapDemand(updated.d), challanNo: updated.challanNo },
    `Demand approved and challan ${updated.challanNo} created`
  ));
});

export const rejectDemand = asyncHandler(async (req: Request, res: Response) => {
  const demand = await prisma.stockDemand.findUnique({
    where: { id: req.params.id },
    include: {
      requestingWH: { select: { type: true, outletId: true } },
      supplyingWH:  { select: { outletId: true } },
    },
  });
  if (!demand) throw new ApiError('Demand not found', 404);
  assertDemandInScope(req, demand.requestingWH?.outletId, demand.supplyingWH?.outletId);
  if (demand.status !== 'PENDING') throw new ApiError('Only pending demands can be rejected', 400);

  // Same approval-level permission for rejection
  if (demand.requestingWH?.type === 'BRANCH' && req.user?.role !== 'Super Admin') {
    throw new ApiError('Only Super Admin can reject branch-to-main demands', 403);
  }
  if (demand.requestingWH?.type === 'KITCHEN' && req.user?.role === 'Super Admin') {
    throw new ApiError('Kitchen demands are handled by branch Manager/Admin, not Super Admin', 403);
  }

  const { reason } = req.body;
  const updated = await prisma.stockDemand.update({
    where: { id: demand.id },
    data: {
      status: 'REJECTED',
      rejectionReason: reason || null,
      rejectedAt: new Date(),
    },
    include: INCLUDE,
  });

  return res.json(ApiResponse.success(mapDemand(updated), 'Demand rejected'));
});

export const cancelDemand = asyncHandler(async (req: Request, res: Response) => {
  const demand = await prisma.stockDemand.findUnique({
    where: { id: req.params.id },
    include: {
      requestingWH: { select: { outletId: true } },
      supplyingWH:  { select: { outletId: true } },
    },
  });
  if (!demand) throw new ApiError('Demand not found', 404);
  assertDemandInScope(req, demand.requestingWH?.outletId, demand.supplyingWH?.outletId);
  if (demand.status !== 'PENDING') throw new ApiError('Only pending demands can be cancelled', 400);
  // Only the requester can cancel their own demand
  if (demand.requestedById !== req.user?.id) throw new ApiError('You can only cancel your own demands', 403);

  const updated = await prisma.stockDemand.update({
    where: { id: demand.id },
    data: { status: 'CANCELLED' },
    include: INCLUDE,
  });

  return res.json(ApiResponse.success(mapDemand(updated), 'Demand cancelled'));
});
