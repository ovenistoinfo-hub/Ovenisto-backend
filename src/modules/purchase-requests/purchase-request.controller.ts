/**
 * Purchase Request Controller
 * Handles purchase requisition workflow: create → approve/reject → purchase
 */

import type { Request, Response } from 'express';
import { prisma } from '../../config/database.js';
import { ApiResponse } from '../../utils/ApiResponse.js';
import { ApiError } from '../../utils/ApiError.js';
import { asyncHandler } from '../../utils/asyncHandler.js';
import { resolveOutletScope } from '../../middleware/outletScope.js';

// Auto-generate request number: PR-YYYYMMDD-XXXX
async function generateRequestNo(): Promise<string> {
  const today = new Date();
  const dateStr = today.toISOString().slice(0, 10).replace(/-/g, '');
  const prefix = `PR-${dateStr}-`;

  const last = await prisma.purchaseRequest.findFirst({
    where: { requestNo: { startsWith: prefix } },
    orderBy: { requestNo: 'desc' },
    select: { requestNo: true },
  });

  let seq = 1;
  if (last) {
    const lastSeq = parseInt(last.requestNo.slice(prefix.length), 10);
    if (!isNaN(lastSeq)) seq = lastSeq + 1;
  }
  return `${prefix}${String(seq).padStart(4, '0')}`;
}

const userSelect = { id: true, name: true, role: true, phone: true, email: true };
const warehouseSelect = { id: true, name: true, type: true, outlet: { select: { id: true, name: true } } };

const itemInclude = {
  ingredient: {
    select: {
      id: true,
      name: true,
      currentStock: true,
      purchasePrice: true,
      unit: { select: { id: true, name: true, symbol: true } },
      category: { select: { id: true, name: true } },
    },
  },
};

// warehouseStockMap: { ingredientId -> currentStock in target warehouse }
function mapRequest(r: any, warehouseStockMap?: Map<string, number>) {
  return {
    ...r,
    items: r.items?.map((item: any) => ({
      ...item,
      requestedQty: Number(item.requestedQty),
      approvedQty: item.approvedQty != null ? Number(item.approvedQty) : null,
      ingredient: item.ingredient ? {
        ...item.ingredient,
        // Use warehouse-specific stock if available, otherwise fall back to global
        currentStock: warehouseStockMap?.has(item.ingredientId)
          ? warehouseStockMap.get(item.ingredientId)!
          : Number(item.ingredient.currentStock),
        purchasePrice: item.ingredient.purchasePrice != null ? Number(item.ingredient.purchasePrice) : null,
      } : item.ingredient,
    })),
  };
}

// Helper: fetch warehouse stock for a list of ingredient IDs in a specific warehouse
async function getWarehouseStockMap(warehouseId: string, ingredientIds: string[]): Promise<Map<string, number>> {
  const stocks = await prisma.warehouseStock.findMany({
    where: { warehouseId, ingredientId: { in: ingredientIds } },
    select: { ingredientId: true, currentStock: true },
  });
  const map = new Map<string, number>();
  for (const s of stocks) map.set(s.ingredientId, Number(s.currentStock));
  // Ingredients not in warehouse get 0
  for (const id of ingredientIds) if (!map.has(id)) map.set(id, 0);
  return map;
}

// Helper: fetch warehouse stock for many (warehouseId, ingredientId) pairs in ONE query.
// Returns a map keyed by `${warehouseId}:${ingredientId}` → currentStock. Avoids the
// N+1 of running getWarehouseStockMap once per purchase-request row in a list.
async function getWarehouseStockMapBatch(
  pairs: { warehouseId: string; ingredientId: string }[]
): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  if (pairs.length === 0) return map;
  const warehouseIds = [...new Set(pairs.map((p) => p.warehouseId))];
  const ingredientIds = [...new Set(pairs.map((p) => p.ingredientId))];
  const stocks = await prisma.warehouseStock.findMany({
    where: { warehouseId: { in: warehouseIds }, ingredientId: { in: ingredientIds } },
    select: { warehouseId: true, ingredientId: true, currentStock: true },
  });
  for (const s of stocks) {
    map.set(`${s.warehouseId}:${s.ingredientId}`, Number(s.currentStock));
  }
  return map;
}

/** GET /api/purchase-requests */
export const getPurchaseRequests = asyncHandler(async (req: Request, res: Response) => {
  const { status, warehouseId, page = '1', limit = '50' } = req.query;
  const where: any = {};

  if (status) where.status = String(status);
  if (warehouseId) where.warehouseId = String(warehouseId);

  // Outlet scoping: filter by the target warehouse's outlet (a PR always targets a BRANCH warehouse).
  const scope = resolveOutletScope(req);
  if (scope) where.warehouse = { outletId: scope };

  const p = Math.max(1, parseInt(String(page), 10) || 1);
  const l = Math.min(100, Math.max(1, parseInt(String(limit), 10) || 50));
  const skip = (p - 1) * l;

  const [data, total] = await Promise.all([
    prisma.purchaseRequest.findMany({
      where,
      skip,
      take: l,
      orderBy: { createdAt: 'desc' },
      include: {
        requestedBy: { select: userSelect },
        approvedBy: { select: userSelect },
        warehouse: { select: warehouseSelect },
        items: { include: itemInclude },
      },
    }),
    prisma.purchaseRequest.count({ where }),
  ]);

  // Fetch warehouse stock for ALL requests' items in ONE query (was N+1: one query per PR row).
  const allPairs = data.flatMap((pr) =>
    pr.items.map((i: any) => ({ warehouseId: pr.warehouseId, ingredientId: i.ingredientId }))
  );
  const combinedStock = await getWarehouseStockMapBatch(allPairs);

  const mapped = data.map((pr) => {
    // Build the per-request map (keyed by ingredientId) that mapRequest expects,
    // sliced from the combined batch result. Missing pairs default to 0.
    const stockMap = new Map<string, number>();
    for (const i of pr.items as any[]) {
      stockMap.set(i.ingredientId, combinedStock.get(`${pr.warehouseId}:${i.ingredientId}`) ?? 0);
    }
    return mapRequest(pr, stockMap);
  });

  res.json(ApiResponse.paginated(mapped, p, l, total));
});

/** GET /api/purchase-requests/:id */
export const getPurchaseRequest = asyncHandler(async (req: Request, res: Response) => {
  const { id } = req.params;

  const pr = await prisma.purchaseRequest.findUnique({
    where: { id },
    include: {
      requestedBy: { select: userSelect },
      approvedBy: { select: userSelect },
      warehouse: { select: warehouseSelect },
      items: { include: itemInclude, orderBy: { ingredient: { name: 'asc' } } },
      purchase: { select: { id: true, invoiceNumber: true, status: true, date: true, total: true } },
    },
  });

  if (!pr) throw ApiError.notFound('Purchase request not found');
  const scope = resolveOutletScope(req);
  if (scope) {
    const wh = await prisma.warehouse.findUnique({ where: { id: pr.warehouseId }, select: { outletId: true } });
    if (wh?.outletId !== scope) throw ApiError.notFound('Purchase request not found');
  }

  const ingredientIds = pr.items.map((i: any) => i.ingredientId);
  const stockMap = ingredientIds.length > 0 ? await getWarehouseStockMap(pr.warehouseId, ingredientIds) : new Map();

  res.json(ApiResponse.success(mapRequest(pr, stockMap)));
});

/** POST /api/purchase-requests */
export const createPurchaseRequest = asyncHandler(async (req: Request, res: Response) => {
  const { warehouseId, items, notes } = req.body;

  if (!warehouseId) throw ApiError.badRequest('Warehouse is required');
  if (!items || !Array.isArray(items) || items.length === 0) throw ApiError.badRequest('At least one item is required');

  // Validate warehouse exists and is BRANCH type
  const warehouse = await prisma.warehouse.findUnique({ where: { id: warehouseId }, select: { id: true, type: true, outletId: true } });
  if (!warehouse) throw ApiError.notFound('Warehouse not found');
  if (warehouse.type !== 'BRANCH') throw ApiError.badRequest('Purchase requests can only target BRANCH warehouses');

  // Outlet scoping: the target warehouse must be in the acting outlet (Super Admin on "All" may target any branch).
  const scope = resolveOutletScope(req);
  if (scope && warehouse.outletId !== scope) {
    throw ApiError.badRequest('Warehouse is not in your outlet');
  }

  // Validate all ingredients exist
  const ingredientIds = items.map((i: any) => i.ingredientId);
  const ingredients = await prisma.ingredient.findMany({ where: { id: { in: ingredientIds } }, select: { id: true } });
  if (ingredients.length !== ingredientIds.length) throw ApiError.badRequest('One or more ingredients not found');

  const requestNo = await generateRequestNo();

  const pr = await prisma.purchaseRequest.create({
    data: {
      requestNo,
      warehouseId,
      requestedById: req.user!.id,
      notes: notes || null,
      items: {
        create: items.map((item: any) => ({
          ingredientId: item.ingredientId,
          requestedQty: item.requestedQty,
        })),
      },
    },
    include: {
      requestedBy: { select: userSelect },
      warehouse: { select: warehouseSelect },
      items: { include: itemInclude },
    },
  });

  const createIngIds = pr.items.map((i: any) => i.ingredientId);
  const createStockMap = createIngIds.length > 0 ? await getWarehouseStockMap(pr.warehouseId, createIngIds) : new Map();
  res.status(201).json(ApiResponse.created(mapRequest(pr, createStockMap)));
});

/** PATCH /api/purchase-requests/:id/approve */
export const approveRequest = asyncHandler(async (req: Request, res: Response) => {
  const { id } = req.params;
  const { items } = req.body;

  const pr = await prisma.purchaseRequest.findUnique({
    where: { id },
    include: { items: true },
  });

  if (!pr) throw ApiError.notFound('Purchase request not found');
  const scope = resolveOutletScope(req);
  if (scope) {
    const wh = await prisma.warehouse.findUnique({ where: { id: pr.warehouseId }, select: { outletId: true } });
    if (wh?.outletId !== scope) throw ApiError.notFound('Purchase request not found');
  }
  if (pr.status !== 'PENDING') throw ApiError.badRequest(`Cannot approve a ${pr.status} request`);

  if (!items || !Array.isArray(items)) throw ApiError.badRequest('Items with approved quantities are required');

  // Build all update operations and run as a batch transaction
  const updateOps = items.map((item: { ingredientId: string; approvedQty: number }) =>
    prisma.purchaseRequestItem.updateMany({
      where: { requestId: id, ingredientId: item.ingredientId },
      data: { approvedQty: item.approvedQty },
    })
  );

  await prisma.$transaction([
    ...updateOps,
    prisma.purchaseRequest.update({
      where: { id },
      data: {
        status: 'APPROVED',
        approvedById: req.user!.id,
        approvedAt: new Date(),
      },
    }),
  ]);

  const updated = await prisma.purchaseRequest.findUnique({
    where: { id },
    include: {
      requestedBy: { select: userSelect },
      approvedBy: { select: userSelect },
      warehouse: { select: warehouseSelect },
      items: { include: itemInclude },
    },
  });

  if (updated) {
    const approveIngIds = updated.items.map((i: any) => i.ingredientId);
    const approveStockMap = approveIngIds.length > 0 ? await getWarehouseStockMap(updated.warehouseId, approveIngIds) : new Map();
    res.json(ApiResponse.success(mapRequest(updated, approveStockMap)));
  } else {
    res.json(ApiResponse.success(null));
  }
});

/** PATCH /api/purchase-requests/:id/reject */
export const rejectRequest = asyncHandler(async (req: Request, res: Response) => {
  const { id } = req.params;
  const { rejectionReason } = req.body;

  const pr = await prisma.purchaseRequest.findUnique({ where: { id } });
  if (!pr) throw ApiError.notFound('Purchase request not found');
  const scope = resolveOutletScope(req);
  if (scope) {
    const wh = await prisma.warehouse.findUnique({ where: { id: pr.warehouseId }, select: { outletId: true } });
    if (wh?.outletId !== scope) throw ApiError.notFound('Purchase request not found');
  }
  if (pr.status !== 'PENDING') throw ApiError.badRequest(`Cannot reject a ${pr.status} request`);

  const updated = await prisma.purchaseRequest.update({
    where: { id },
    data: {
      status: 'REJECTED',
      rejectionReason: rejectionReason || null,
      rejectedAt: new Date(),
      approvedById: req.user!.id,
    },
    include: {
      requestedBy: { select: userSelect },
      approvedBy: { select: userSelect },
      warehouse: { select: warehouseSelect },
      items: { include: itemInclude },
    },
  });

  const rejectIngIds = updated.items.map((i: any) => i.ingredientId);
  const rejectStockMap = rejectIngIds.length > 0 ? await getWarehouseStockMap(updated.warehouseId, rejectIngIds) : new Map();
  res.json(ApiResponse.success(mapRequest(updated, rejectStockMap)));
});

/** PATCH /api/purchase-requests/:id/cancel */
export const cancelRequest = asyncHandler(async (req: Request, res: Response) => {
  const { id } = req.params;

  const pr = await prisma.purchaseRequest.findUnique({ where: { id } });
  if (!pr) throw ApiError.notFound('Purchase request not found');
  const scope = resolveOutletScope(req);
  if (scope) {
    const wh = await prisma.warehouse.findUnique({ where: { id: pr.warehouseId }, select: { outletId: true } });
    if (wh?.outletId !== scope) throw ApiError.notFound('Purchase request not found');
  }
  if (pr.status !== 'PENDING') throw ApiError.badRequest(`Cannot cancel a ${pr.status} request`);
  if (pr.requestedById !== req.user!.id) throw ApiError.forbidden('You can only cancel your own requests');

  const updated = await prisma.purchaseRequest.update({
    where: { id },
    data: { status: 'CANCELLED' },
    include: {
      requestedBy: { select: userSelect },
      warehouse: { select: warehouseSelect },
      items: { include: itemInclude },
    },
  });

  const cancelIngIds = updated.items.map((i: any) => i.ingredientId);
  const cancelStockMap = cancelIngIds.length > 0 ? await getWarehouseStockMap(updated.warehouseId, cancelIngIds) : new Map();
  res.json(ApiResponse.success(mapRequest(updated, cancelStockMap)));
});
