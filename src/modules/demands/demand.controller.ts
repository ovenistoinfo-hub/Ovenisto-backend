/**
 * Stock Demand Controller — Phase W4
 */
import type { Request, Response } from 'express';
import { prisma } from '../../config/database.js';
import { ApiResponse } from '../../utils/ApiResponse.js';
import { ApiError } from '../../utils/ApiError.js';
import { asyncHandler } from '../../utils/asyncHandler.js';

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
    requestedBy:  d.requestedBy  ? { id: d.requestedBy.id,  name: d.requestedBy.name  } : null,
    approvedBy:   d.approvedBy   ? { id: d.approvedBy.id,   name: d.approvedBy.name   } : null,
    approvedAt:  d.approvedAt,
    fulfilledAt: d.fulfilledAt,
    rejectedAt:  d.rejectedAt,
    createdAt:   d.createdAt,
    items: d.items.map((i: any) => ({
      id: i.id,
      ingredientId: i.ingredientId,
      ingredientName: i.ingredient.name,
      unit: i.ingredient.unit?.symbol || i.ingredient.unit?.name || '—',
      requestedQty: Number(i.requestedQty),
      approvedQty: i.approvedQty !== null ? Number(i.approvedQty) : null,
    })),
  };
}

const INCLUDE = {
  requestingWH: { select: { id: true, name: true, type: true } },
  supplyingWH:  { select: { id: true, name: true, type: true } },
  requestedBy:  { select: { id: true, name: true } },
  approvedBy:   { select: { id: true, name: true } },
  items: {
    include: {
      ingredient: { select: { id: true, name: true, unit: { select: { symbol: true, name: true } } } },
    },
  },
};

export const getDemands = asyncHandler(async (req: Request, res: Response) => {
  const { status, requestingWHId, supplyingWHId } = req.query as Record<string, string>;
  const where: any = {};
  if (status)          where.status          = status;
  if (requestingWHId)  where.requestingWHId  = requestingWHId;
  if (supplyingWHId)   where.supplyingWHId   = supplyingWHId;

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
        })),
      },
    },
    include: INCLUDE,
  });

  return res.status(201).json(ApiResponse.created(mapDemand(demand), 'Demand created'));
});

export const approveDemand = asyncHandler(async (req: Request, res: Response) => {
  const demand = await prisma.stockDemand.findUnique({ where: { id: req.params.id }, include: { items: true } });
  if (!demand) throw new ApiError('Demand not found', 404);
  if (demand.status !== 'PENDING') throw new ApiError('Only pending demands can be approved', 400);

  const { items: itemsInput } = req.body || {};

  // Auto-generate challan number
  const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const count = await prisma.stockChallan.count({ where: { challanNo: { startsWith: `CHN-${today}` } } });
  const challanNo = `CHN-${today}-${String(count + 1).padStart(4, '0')}`;

  const updated = await prisma.$transaction(async (tx) => {
    // Build challan items from approvedQty or requestedQty
    const challanItems = demand.items.map((i) => {
      const override = itemsInput?.find((x: any) => x.id === i.id);
      const qty = override?.approvedQty ?? Number(i.requestedQty);
      return { ingredientId: i.ingredientId, qty };
    }).filter((i) => Number(i.qty) > 0);

    if (challanItems.length === 0) throw new ApiError('At least one item must have approved qty > 0', 400);

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
  }, { timeout: 30000 });

  return res.json(ApiResponse.success(
    { ...mapDemand(updated.d), challanNo: updated.challanNo },
    `Demand approved and challan ${updated.challanNo} created`
  ));
});

export const rejectDemand = asyncHandler(async (req: Request, res: Response) => {
  const demand = await prisma.stockDemand.findUnique({ where: { id: req.params.id } });
  if (!demand) throw new ApiError('Demand not found', 404);
  if (demand.status !== 'PENDING') throw new ApiError('Only pending demands can be rejected', 400);

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
