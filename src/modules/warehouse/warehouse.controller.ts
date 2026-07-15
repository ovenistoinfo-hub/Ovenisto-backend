/**
 * Warehouse Controller
 * CRUD for warehouse management and warehouse stock tracking
 */

import type { Request, Response } from 'express';
import { prisma } from '../../config/database.js';
import { ApiResponse } from '../../utils/ApiResponse.js';
import { ApiError } from '../../utils/ApiError.js';
import { asyncHandler } from '../../utils/asyncHandler.js';
import { resolveOutletScope } from '../../middleware/outletScope.js';
import {
  canReadWarehouse,
  resolveDashboardScope,
  nullableWarehouseGate,
  twoEndpointGate,
} from './warehouse.access.js';

/**
 * Loads a warehouse and 404s if the caller may not read it — 404 rather than
 * 403, so we never leak the existence of another outlet's warehouse.
 */
async function assertReadableWarehouse(req: Request, id: string): Promise<void> {
  const warehouse = await prisma.warehouse.findUnique({
    where: { id },
    select: { type: true, outletId: true },
  });
  if (!warehouse || !canReadWarehouse(req.user?.role, req.user?.outletId, warehouse)) {
    throw ApiError.notFound('Warehouse not found');
  }
}

// ── Auto-generate warehouse code ──
async function generateUniqueCode(type: string): Promise<string> {
  const typeMap: Record<string, string> = { MAIN: 'MA', BRANCH: 'BR', KITCHEN: 'KI' };
  const prefix = typeMap[type] || 'WH';

  let n = 1;
  while (n <= 999) {
    const candidate = `${prefix}-${String(n).padStart(3, '0')}`;
    const exists = await prisma.warehouse.findUnique({ where: { code: candidate } });
    if (!exists) return candidate;
    n++;
  }
  return `${prefix}-${Date.now().toString().slice(-3)}`;
}

const ADMIN_ROLES = ['Super Admin'];

/** GET /api/warehouses */
export const getWarehouses = asyncHandler(async (req: Request, res: Response) => {
  const { type, isActive = 'true' } = req.query;
  const where: any = { isActive: isActive === 'true' };

  if (type) where.type = String(type);
  const scope = resolveOutletScope(req);

  if (ADMIN_ROLES.includes(req.user?.role || '')) {
    // Super Admin: apply outlet header scope if set; null = see everything
    if (scope) where.outletId = scope;
  } else {
    // All other roles: own outlet's warehouses + MAIN (so MAIN is always
    // visible as a supply source for BRANCH→MAIN demand flow)
    if (req.user?.outletId) {
      where.OR = [
        { outletId: req.user.outletId },
        { type: 'MAIN' },
      ];
    } else {
      // No outlet assigned → only MAIN type
      where.type = 'MAIN';
    }
  }

  const warehouses = await prisma.warehouse.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    include: {
      outlet: { select: { id: true, name: true } },
      manager: { select: { id: true, name: true } },
      _count: { select: { warehouseStock: true } },
    },
  });

  res.json(ApiResponse.success(warehouses));
});

/** GET /api/warehouses/:id */
export const getWarehouse = asyncHandler(async (req: Request, res: Response) => {
  const { id } = req.params;

  const warehouse = await prisma.warehouse.findUnique({
    where: { id },
    include: {
      outlet: { select: { id: true, name: true } },
      manager: { select: { id: true, name: true } },
      warehouseStock: {
        include: { ingredient: { include: { unit: true } } },
      },
    },
  });

  if (!warehouse || !canReadWarehouse(req.user?.role, req.user?.outletId, warehouse)) {
    throw ApiError.notFound('Warehouse not found');
  }
  res.json(ApiResponse.success(warehouse));
});

/** GET /api/warehouses/:id/stock */
export const getWarehouseStock = asyncHandler(async (req: Request, res: Response) => {
  const { id } = req.params;
  const { categoryId, search, lowStockOnly } = req.query;

  const warehouse = await prisma.warehouse.findUnique({ where: { id } });
  if (!warehouse || !canReadWarehouse(req.user?.role, req.user?.outletId, warehouse)) {
    throw ApiError.notFound('Warehouse not found');
  }

  const where: any = { warehouseId: id };

  const stocks = await prisma.warehouseStock.findMany({
    where,
    include: {
      ingredient: {
        include: {
          unit: { select: { id: true, name: true, symbol: true } },
          category: { select: { id: true, name: true } },
          supplier: { select: { id: true, name: true } },
        },
      },
    },
  });

  // Filter by category if provided
  let filtered = stocks;
  if (categoryId) {
    filtered = filtered.filter(s => s.ingredient.category?.id === String(categoryId));
  }

  // Filter by search (ingredient name) if provided
  if (search) {
    const searchLower = String(search).toLowerCase();
    filtered = filtered.filter(s => s.ingredient.name.toLowerCase().includes(searchLower));
  }

  // Filter low stock if requested
  if (lowStockOnly === 'true') {
    filtered = filtered.filter(s => Number(s.currentStock) <= Number(s.lowStockLevel));
  }

  // Map response
  const mapped = filtered.map(s => ({
    id: s.id,
    currentStock: Number(s.currentStock),
    lowStockLevel: Number(s.lowStockLevel),
    ingredient: {
      id: s.ingredient.id,
      name: s.ingredient.name,
      brand: s.ingredient.brand || null,
      purchasePrice: s.ingredient.purchasePrice ? Number(s.ingredient.purchasePrice) : null,
      supplierId: s.ingredient.supplierId || null,
      supplier: s.ingredient.supplier ? {
        id: s.ingredient.supplier.id,
        name: s.ingredient.supplier.name,
      } : null,
      unit: s.ingredient.unit ? {
        id: s.ingredient.unit.id,
        name: s.ingredient.unit.name,
        symbol: s.ingredient.unit.symbol || '',
      } : null,
      category: s.ingredient.category ? {
        id: s.ingredient.category.id,
        name: s.ingredient.category.name,
      } : null,
    },
  }));

  res.json(ApiResponse.success(mapped));
});

/** GET /api/warehouses/:id/expiry-summary */
export const getWarehouseExpirySummary = asyncHandler(async (req: Request, res: Response) => {
  const { id } = req.params;
  await assertReadableWarehouse(req, id);

  const now = new Date();
  const nearExpiryThreshold = new Date();
  nearExpiryThreshold.setDate(now.getDate() + 7);

  // Fetch all batches with expiry dates and remaining qty > 0
  const batches = await prisma.stockBatch.findMany({
    where: {
      warehouseId: id,
      remainingQty: { gt: 0 },
      expiryDate: { not: null },
    },
    include: {
      ingredient: {
        select: {
          id: true,
          name: true,
          brand: true,
          unit: { select: { name: true, symbol: true } },
        },
      },
    },
    orderBy: { expiryDate: 'asc' },
  });

  // Fetch warehouse stock for affected ingredients to get total current stock
  const ingredientIds = [...new Set(batches.map(b => b.ingredientId))];
  const warehouseStocks = ingredientIds.length > 0 ? await prisma.warehouseStock.findMany({
    where: { warehouseId: id, ingredientId: { in: ingredientIds } },
    select: { ingredientId: true, currentStock: true },
  }) : [];
  const stockMap = new Map(warehouseStocks.map(s => [s.ingredientId, Number(s.currentStock)]));

  const mapped = batches.map(b => ({
    id: b.id,
    ingredientId: b.ingredientId,
    ingredientName: b.ingredient.name,
    brand: b.ingredient.brand,
    unit: b.ingredient.unit?.symbol || b.ingredient.unit?.name || '',
    batchQty: Number(b.batchQty),
    remainingQty: Number(b.remainingQty),
    expiryDate: b.expiryDate!.toISOString().split('T')[0],
    purchasedAt: b.createdAt.toISOString().split('T')[0],
    totalCurrentStock: stockMap.get(b.ingredientId) ?? 0,
  }));

  const expired = mapped.filter(b => new Date(b.expiryDate) < now);
  const nearExpiry = mapped.filter(b => {
    const d = new Date(b.expiryDate);
    return d >= now && d <= nearExpiryThreshold;
  });

  // Group by ingredient for summary
  function groupByIngredient(items: typeof mapped) {
    const groups: Record<string, {
      ingredientId: string; ingredientName: string; brand: string | null; unit: string;
      totalCurrentStock: number;
      affectedQty: number; // sum of remainingQty of expired/near-expiry batches
      safeQty: number; // totalCurrentStock - affectedQty
      batches: typeof mapped;
    }> = {};
    for (const item of items) {
      if (!groups[item.ingredientId]) {
        groups[item.ingredientId] = {
          ingredientId: item.ingredientId,
          ingredientName: item.ingredientName,
          brand: item.brand,
          unit: item.unit,
          totalCurrentStock: item.totalCurrentStock,
          affectedQty: 0,
          safeQty: 0,
          batches: [],
        };
      }
      groups[item.ingredientId].affectedQty += item.remainingQty;
      groups[item.ingredientId].batches.push(item);
    }
    // Calculate safe qty
    for (const g of Object.values(groups)) {
      g.safeQty = Math.max(0, g.totalCurrentStock - g.affectedQty);
    }
    return Object.values(groups);
  }

  res.json(ApiResponse.success({
    expiredCount: expired.length,
    nearExpiryCount: nearExpiry.length,
    expired: groupByIngredient(expired),
    nearExpiry: groupByIngredient(nearExpiry),
  }));
});

/** GET /api/warehouses/:id/consumption?limit=50 */
export const getWarehouseConsumption = asyncHandler(async (req: Request, res: Response) => {
  const { id } = req.params;
  const limit = Math.min(Number(req.query.limit) || 50, 200);

  const warehouse = await prisma.warehouse.findUnique({ where: { id } });
  if (!warehouse || !canReadWarehouse(req.user?.role, req.user?.outletId, warehouse)) {
    throw ApiError.notFound('Warehouse not found');
  }

  const logs = await prisma.stockAdjustment.findMany({
    where: { warehouseId: id, type: 'deduct' },
    orderBy: { date: 'desc' },
    take: limit,
    include: {
      ingredient: { select: { id: true, name: true, unit: { select: { symbol: true, name: true } } } },
    },
  });

  const data = logs.map((l) => ({
    id: l.id,
    date: l.date,
    ingredientId: l.ingredientId,
    ingredientName: l.ingredient.name,
    unit: l.ingredient.unit?.symbol || l.ingredient.unit?.name || '—',
    qty: Number(l.quantity),
    reason: l.reason,
  }));

  res.json(ApiResponse.success(data));
});

/** POST /api/warehouses */
export const createWarehouse = asyncHandler(async (req: Request, res: Response) => {
  const { name, code, type, outletId, managerId, address } = req.body;

  if (!name?.trim()) throw ApiError.badRequest('Warehouse name is required');
  if (!address?.trim()) throw ApiError.badRequest('Warehouse address is required');
  if (!type) throw ApiError.badRequest('Warehouse type is required');

  // Outlet-scoping invariant: BRANCH/KITCHEN warehouses must belong to an outlet;
  // the central MAIN warehouse must not. (Derived outlet scoping relies on this.)
  if ((type === 'BRANCH' || type === 'KITCHEN') && !outletId) {
    throw ApiError.badRequest('A branch/kitchen warehouse must belong to an outlet');
  }
  if (type === 'MAIN' && outletId) {
    throw ApiError.badRequest('A main (central) warehouse must not belong to an outlet');
  }

  // Auto-generate code if not provided
  let finalCode = code;
  if (!finalCode) {
    finalCode = await generateUniqueCode(type);
  } else if (finalCode.trim()) {
    const codeTaken = await prisma.warehouse.findUnique({ where: { code: finalCode.trim() } });
    if (codeTaken) throw ApiError.conflict('A warehouse with this code already exists');
    finalCode = finalCode.trim();
  }

  const warehouse = await prisma.warehouse.create({
    data: {
      name: name.trim(),
      code: finalCode,
      address: address.trim(),
      type,
      outletId: outletId || null,
      managerId: managerId || null,
    },
    include: {
      outlet: { select: { id: true, name: true } },
      manager: { select: { id: true, name: true } },
      _count: { select: { warehouseStock: true } },
    },
  });

  res.status(201).json(ApiResponse.created(warehouse, 'Warehouse created'));
});

/** PUT /api/warehouses/:id */
export const updateWarehouse = asyncHandler(async (req: Request, res: Response) => {
  const { id } = req.params;
  const { name, code, outletId, managerId, isActive, address } = req.body;

  const existing = await prisma.warehouse.findUnique({ where: { id } });
  if (!existing) throw ApiError.notFound('Warehouse not found');

  if (address !== undefined && !address.trim()) {
    throw ApiError.badRequest('Warehouse address cannot be empty');
  }

  if (code && code !== existing.code) {
    const codeTaken = await prisma.warehouse.findUnique({ where: { code } });
    if (codeTaken) throw ApiError.conflict('A warehouse with this code already exists');
  }

  // Outlet-scoping invariant (type is immutable here — check against existing.type):
  // BRANCH/KITCHEN must keep an outlet; MAIN must stay outlet-less.
  if (outletId !== undefined) {
    if ((existing.type === 'BRANCH' || existing.type === 'KITCHEN') && !outletId) {
      throw ApiError.badRequest('A branch/kitchen warehouse must belong to an outlet');
    }
    if (existing.type === 'MAIN' && outletId) {
      throw ApiError.badRequest('A main (central) warehouse must not belong to an outlet');
    }
  }

  const warehouse = await prisma.warehouse.update({
    where: { id },
    data: {
      ...(name && { name: name.trim() }),
      ...(code !== undefined && { code: code?.trim() || existing.code }),
      ...(outletId !== undefined && { outletId: outletId || null }),
      ...(managerId !== undefined && { managerId: managerId || null }),
      ...(isActive !== undefined && { isActive }),
      ...(address !== undefined && { address: address.trim() }),
    },
    include: {
      outlet: { select: { id: true, name: true } },
      manager: { select: { id: true, name: true } },
      _count: { select: { warehouseStock: true } },
    },
  });

  res.json(ApiResponse.success(warehouse, 'Warehouse updated'));
});

/** DELETE /api/warehouses/:id */
export const deleteWarehouse = asyncHandler(async (req: Request, res: Response) => {
  const { id } = req.params;

  const warehouse = await prisma.warehouse.findUnique({
    where: { id },
    include: { warehouseStock: true },
  });

  if (!warehouse) throw ApiError.notFound('Warehouse not found');

  // Check if any active stock exists with currentStock > 0
  const activeStock = warehouse.warehouseStock.some(s => Number(s.currentStock) > 0);
  if (activeStock) {
    throw ApiError.badRequest('Cannot delete warehouse with active stock. Transfer or adjust stock first.');
  }

  // Soft delete
  await prisma.warehouse.update({
    where: { id },
    data: { isActive: false },
  });

  res.json(ApiResponse.success(null, 'Warehouse deleted'));
});

/** GET /api/warehouses/dashboard-stats */
export const getWarehouseDashboard = asyncHandler(async (req: Request, res: Response) => {
  const { warehouseId, startDate, endDate } = req.query;

  // 1. Date Filters
  const dateFilter: any = {};
  if (startDate || endDate) {
    dateFilter.createdAt = {};
    if (startDate) dateFilter.createdAt.gte = new Date(String(startDate));
    if (endDate) {
      const end = new Date(String(endDate));
      end.setHours(23, 59, 59, 999);
      dateFilter.createdAt.lte = end;
    }
  }

  // 2. Who is asking → which warehouses may they see?
  //    Super Admin    → all (honouring the X-Outlet-Id header)
  //    Admin, Manager → own outlet: BRANCH + KITCHEN
  //    Store Manager  → own outlet: BRANCH   |  Kitchen Manager → own outlet: KITCHEN
  //    MAIN is Super-Admin-only, for free: BRANCH/KITCHEN always carry an outletId,
  //    MAIN never does, so an `outletId` filter already excludes it.
  const scope = resolveDashboardScope(req.user?.role, resolveOutletScope(req));

  // 3. The caller's visible warehouses — this IS the filter dropdown's source.
  const activeWarehouses = await prisma.warehouse.findMany({
    where: scope.where,
    select: { id: true, name: true, type: true, outletId: true }
  });
  const visibleIds = activeWarehouses.map(w => w.id);

  // A client may only ask for a warehouse it can already see. 404, never 403 — a
  // wrong id must not confirm that someone else's warehouse exists.
  const selectedId = warehouseId && warehouseId !== 'all' ? String(warehouseId) : null;
  if (selectedId && !visibleIds.includes(selectedId)) {
    throw ApiError.notFound('Warehouse not found');
  }

  // The selected warehouse's type/outletId drives which owner-dashboard cards apply:
  // Receivable (Due to Main) only makes sense for MAIN; Invoices only makes sense for a
  // warehouse that has an outlet (BRANCH/KITCHEN) — MAIN has none, so it stays zero.
  const selectedWarehouse = selectedId
    ? activeWarehouses.find(w => w.id === selectedId) ?? null
    : null;

  // Every aggregate below is confined to these ids. An empty list (e.g. a Kitchen
  // Manager whose outlet has no kitchen warehouse) yields `in: []` → an all-zero
  // dashboard, which is the correct answer rather than an error.
  const targetIds = selectedId ? [selectedId] : visibleIds;

  // WarehouseStock.warehouseId is NOT nullable, so a plain IN is safe here.
  const whStockFilter = scope.unrestricted && !selectedId
    ? {}
    : { warehouseId: { in: targetIds } };

  // 4. Calculate total stock value (Inventory Value = sum of currentStock * purchasePrice)
  const stockItems = await prisma.warehouseStock.findMany({
    where: whStockFilter,
    include: {
      ingredient: {
        select: {
          id: true,
          name: true,
          purchasePrice: true,
          lowStockLevel: true,
          category: { select: { name: true } },
          supplier: { select: { name: true } },
          unit: { select: { name: true, symbol: true } }
        }
      }
    }
  });

  let totalInventoryValue = 0;
  const stockCostingTable: any[] = [];

  if (selectedId) {
    // Specific Warehouse: return its stock records directly
    for (const item of stockItems) {
      const currentStock = Number(item.currentStock) || 0;
      const lowStockLevel = Number(item.lowStockLevel) || Number(item.ingredient.lowStockLevel) || 0;
      const unitPrice = Number(item.ingredient.purchasePrice) || 0;
      const totalVal = currentStock * unitPrice;
      totalInventoryValue += totalVal;

      stockCostingTable.push({
        ingredientId: item.ingredient.id,
        name: item.ingredient.name,
        category: item.ingredient.category?.name || '—',
        currentStock,
        lowStockLevel,
        unitPrice,
        totalValue: totalVal,
        vendorName: item.ingredient.supplier?.name || '—',
        unitName: item.ingredient.unit?.name || '',
        unitSymbol: item.ingredient.unit?.symbol || ''
      });
    }
  } else {
    // "All Warehouses": Aggregate stock quantity and total value per ingredient across all warehouses
    const map = new Map<string, any>();
    for (const item of stockItems) {
      const currentStock = Number(item.currentStock) || 0;
      const lowStockLevel = Number(item.lowStockLevel) || Number(item.ingredient.lowStockLevel) || 0;
      const unitPrice = Number(item.ingredient.purchasePrice) || 0;
      const totalVal = currentStock * unitPrice;
      totalInventoryValue += totalVal;

      const existing = map.get(item.ingredient.id);
      if (existing) {
        existing.currentStock += currentStock;
        existing.totalValue += totalVal;
        existing.lowStockLevel = Math.max(existing.lowStockLevel, lowStockLevel);
      } else {
        map.set(item.ingredient.id, {
          ingredientId: item.ingredient.id,
          name: item.ingredient.name,
          category: item.ingredient.category?.name || '—',
          currentStock,
          lowStockLevel,
          unitPrice,
          totalValue: totalVal,
          vendorName: item.ingredient.supplier?.name || '—',
          unitName: item.ingredient.unit?.name || '',
          unitSymbol: item.ingredient.unit?.symbol || ''
        });
      }
    }
    stockCostingTable.push(...map.values());
  }

  // Sort costing table by total value desc
  stockCostingTable.sort((a, b) => b.totalValue - a.totalValue);

  // 5. Purchases Metrics (Procurement side)
  // Purchase.warehouseId is NULLABLE — a bare `IN (...)` would silently drop every
  // purchase booked without a warehouse, so nullableWarehouseGate adds those back by
  // their own outletId.
  const purchaseWhere: any = {
    ...dateFilter,
    ...(nullableWarehouseGate(scope, visibleIds, selectedId) ?? {}),
  };

  const purchases = await prisma.purchase.findMany({
    where: purchaseWhere,
    select: { total: true, paid: true, due: true, tax: true, discount: true }
  });

  const totalPurchasesCount = purchases.length;
  const totalProcurementCost = purchases.reduce((s, p) => s + Number(p.total), 0);
  const avgProcurementValue = totalPurchasesCount > 0 ? totalProcurementCost / totalPurchasesCount : 0;
  const totalVendorPayments = purchases.reduce((s, p) => s + Number(p.paid), 0);
  const totalUnpaidToVendors = purchases.reduce((s, p) => s + Number(p.due), 0);
  const totalGstOnPurchases = purchases.reduce((s, p) => s + Number(p.tax || 0), 0);
  const totalDiscountOnPurchases = purchases.reduce((s, p) => s + Number(p.discount || 0), 0);

  // Every Purchase enters stock instantly on creation (no separate "awaited" stage exists
  // yet) — so "Stock Received" is simply every purchase, split by paid vs still-due.
  const stockReceivedUnpaid = purchases.filter(p => Number(p.due) > 0);
  const stockReceivedPaid = purchases.filter(p => Number(p.due) <= 0);
  const unpaidToVendorsCount = stockReceivedUnpaid.length;

  // Purchase Requests counts — PurchaseRequest.warehouseId is required, so a plain IN
  // is safe (it has no outletId column; outlet is derived through the warehouse).
  const prWhere: any = { ...dateFilter };
  if (!(scope.unrestricted && !selectedId)) {
    prWhere.warehouseId = { in: targetIds };
  }
  const purchaseRequests = await prisma.purchaseRequest.findMany({
    where: prWhere,
    select: { status: true }
  });
  const pendingRequestsCount = purchaseRequests.filter(pr => pr.status === 'PENDING').length;
  const approvedRequestsCount = purchaseRequests.filter(pr => pr.status === 'APPROVED').length;

  // 5b. Receivable — chain-wide amount branches owe Main for received stock transfers
  // (the WarehouseSettlement/dueToMain ledger). Only meaningful when Main is the selected
  // warehouse (or no warehouse is selected) — a Branch/Kitchen doesn't have this ledger.
  // This is the CENTRAL store's ledger (what every branch owes Main), so it is Super
  // Admin only — a branch role must not see chain-wide receivables. A Super Admin who
  // has picked one outlet sees just that outlet's share.
  let receivableValue = 0;
  let receivableOutletsOwing = 0;
  if (scope.isSuperAdmin && (!selectedWarehouse || selectedWarehouse.type === 'MAIN')) {
    const outlets = await prisma.outlet.findMany({
      where: scope.outletId ? { id: scope.outletId } : {},
      select: { dueToMain: true },
    });
    receivableValue = outlets.reduce((s, o) => s + Number(o.dueToMain), 0);
    receivableOutletsOwing = outlets.filter(o => Number(o.dueToMain) > 0).length;
  }

  // 6. Demands & Challans Metrics (Distribution/Outflow side)
  // Both models have TWO warehouse endpoints. When one warehouse is selected we keep
  // the existing metric semantics (demands key on supplyingWHId, challans on
  // fromWarehouseId). With no selection, visibility is strict-endpoint — the row counts
  // if EITHER end is a warehouse you can see — otherwise a branch would never see the
  // inbound MAIN→BRANCH transfers it cares most about.
  let demandWhere: any = { ...dateFilter };
  if (selectedId) {
    if (selectedWarehouse?.type === 'MAIN') {
      demandWhere.supplyingWHId = selectedId;
    } else if (selectedWarehouse?.type === 'KITCHEN') {
      demandWhere.requestingWHId = selectedId;
    } else {
      demandWhere.OR = [
        { supplyingWHId: selectedId },
        { requestingWHId: selectedId }
      ];
    }
  } else {
    demandWhere = {
      ...dateFilter,
      ...(twoEndpointGate(scope, visibleIds, selectedId, 'supplyingWHId', 'requestingWHId') ?? {}),
    };
  }
  const demands = await prisma.stockDemand.findMany({
    where: demandWhere,
    select: { status: true }
  });
  const totalDemandsCount = demands.length;
  const fulfilledDemandsCount = demands.filter(d => d.status === 'FULFILLED').length;
  const pendingDemandsCount = demands.filter(d => d.status === 'PENDING').length;

  // Challans
  const challanWhere: any = {
    ...dateFilter,
    ...(twoEndpointGate(scope, visibleIds, selectedId, 'fromWarehouseId', 'toWarehouseId') ?? {}),
  };
  const challans = await prisma.stockChallan.findMany({
    where: challanWhere,
    include: {
      items: {
        include: {
          ingredient: { select: { purchasePrice: true } }
        }
      }
    }
  });

  const totalChallansCount = challans.length;
  const pendingChallansCount = challans.filter(c => c.status === 'PENDING').length;
  const dispatchedChallansCount = challans.filter(c => c.status === 'DISPATCHED').length;
  const receivedChallansCount = challans.filter(c => c.status === 'RECEIVED').length;
  const totalShippingCosts = challans.reduce((s, c) => s + Number(c.shippingCost || 0), 0);
  const totalChallanPaid = challans.reduce((s, c) => s + Number(c.paid || 0), 0);

  // Compute Outflow Value of dispatched/received challans
  let totalOutflowValue = 0;
  for (const c of challans) {
    for (const item of c.items) {
      const qty = Number(item.qty) || 0;
      const price = Number(item.ingredient.purchasePrice) || 0;
      totalOutflowValue += qty * price;
    }
  }

  // 7. Recent Transactions (Movements Log)
  const recentTransactions: any[] = [];

  // Recent Purchases
  const recentPurchs = await prisma.purchase.findMany({
    where: purchaseWhere,
    orderBy: { createdAt: 'desc' },
    take: 10,
    include: {
      supplier: { select: { name: true } },
      warehouse: { select: { name: true } }
    }
  });
  for (const p of recentPurchs) {
    recentTransactions.push({
      date: p.createdAt,
      type: 'INBOUND',
      module: 'Purchase',
      description: `Purchased from ${p.supplier?.name || 'Unknown Supplier'}`,
      target: p.warehouse?.name || '—',
      value: Number(p.total)
    });
  }

  // Recent Challans
  const recentChalls = await prisma.stockChallan.findMany({
    where: challanWhere,
    orderBy: { createdAt: 'desc' },
    take: 10,
    include: {
      fromWarehouse: { select: { name: true } },
      toWarehouse: { select: { name: true } },
      items: { include: { ingredient: { select: { purchasePrice: true } } } }
    }
  });
  for (const c of recentChalls) {
    let val = 0;
    for (const item of c.items) {
      val += (Number(item.qty) || 0) * (Number(item.ingredient.purchasePrice) || 0);
    }
    recentTransactions.push({
      date: c.createdAt,
      type: c.status === 'RECEIVED' ? 'RECEIVED' : 'OUTBOUND',
      module: 'Challan',
      description: `Stock Challan (${c.challanNo}) - ${c.status}`,
      target: `${c.fromWarehouse.name} ➔ ${c.toWarehouse.name}`,
      value: val
    });
  }

  // Recent Waste. WasteRecord.warehouseId is NULLABLE (waste can come from a sale or a
  // purchase with no warehouse), so the same gate as purchases: warehouse-set match, or
  // no warehouse but our outlet.
  const wasteWhere: any = dateFilter.createdAt
    ? { date: { gte: dateFilter.createdAt.gte, lte: dateFilter.createdAt.lte } }
    : {};
  Object.assign(wasteWhere, nullableWarehouseGate(scope, visibleIds, selectedId) ?? {});
  // Waste total (top KPI) — same scope as the recent-waste list above.
  const wasteAgg = await prisma.wasteRecord.aggregate({
    where: wasteWhere,
    _sum: { cost: true },
    _count: { _all: true },
  });
  const wasteValue = Math.round(Number(wasteAgg._sum.cost ?? 0));
  const wasteCount = wasteAgg._count._all;

  const recentWaste = await prisma.wasteRecord.findMany({
    where: wasteWhere,
    orderBy: { date: 'desc' },
    take: 10,
    select: {
      date: true,
      itemName: true,
      reason: true,
      cost: true,
    }
  });
  for (const w of recentWaste) {
    recentTransactions.push({
      date: w.date,
      type: 'OUTBOUND',
      module: 'Waste',
      description: `Waste: ${w.itemName || 'Unknown item'} — ${w.reason || 'No reason'}`,
      target: '—',
      value: Number(w.cost || 0)
    });
  }

  // Sort recent transactions combined
  recentTransactions.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
  const finalTransactions = recentTransactions.slice(0, 15);

  res.json(ApiResponse.success({
    activeWarehouses,
    inventoryValue: Math.round(totalInventoryValue),
    payable: Math.round(totalUnpaidToVendors),
    receivable: Math.round(receivableValue),
    receivableOutletsOwing,
    waste: wasteValue,
    wasteCount,
    costingTable: stockCostingTable,
    recentTransactions: finalTransactions,
    procurement: {
      totalOrders: totalPurchasesCount,
      procurementCost: Math.round(totalProcurementCost),
      avgValue: Math.round(avgProcurementValue),
      payments: Math.round(totalVendorPayments),
      unpaid: Math.round(totalUnpaidToVendors),
      unpaidCount: unpaidToVendorsCount,
      discount: Math.round(totalDiscountOnPurchases),
      gst: Math.round(totalGstOnPurchases),
      pendingRequests: pendingRequestsCount,
      approvedRequests: approvedRequestsCount,
      stockReceivedPaid: Math.round(stockReceivedPaid.reduce((s, p) => s + Number(p.total), 0)),
      stockReceivedPaidCount: stockReceivedPaid.length,
      stockReceivedUnpaid: Math.round(stockReceivedUnpaid.reduce((s, p) => s + Number(p.total), 0)),
      stockReceivedUnpaidCount: stockReceivedUnpaid.length,
    },
    distribution: {
      totalDemands: totalDemandsCount,
      fulfilledDemands: fulfilledDemandsCount,
      pendingDemands: pendingDemandsCount,
      totalChallans: totalChallansCount,
      pendingChallans: pendingChallansCount,
      dispatchedChallans: dispatchedChallansCount,
      receivedChallans: receivedChallansCount,
      outflowValue: Math.round(totalOutflowValue),
      shippingCosts: Math.round(totalOutflowValue > 0 ? totalShippingCosts : 0),
      totalPaid: Math.round(totalChallanPaid)
    },
  }));
});

