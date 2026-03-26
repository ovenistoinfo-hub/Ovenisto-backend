/**
 * Warehouse Controller
 * CRUD for warehouse management and warehouse stock tracking
 */

import type { Request, Response } from 'express';
import { prisma } from '../../config/database.js';
import { ApiResponse } from '../../utils/ApiResponse.js';
import { ApiError } from '../../utils/ApiError.js';
import { asyncHandler } from '../../utils/asyncHandler.js';

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

const ADMIN_ROLES = ['Super Admin', 'Admin'];

/** GET /api/warehouses */
export const getWarehouses = asyncHandler(async (req: Request, res: Response) => {
  const { type, outletId, isActive = 'true' } = req.query;
  const where: any = { isActive: isActive === 'true' };

  if (type) where.type = String(type);
  if (outletId) where.outletId = String(outletId);

  // W6: Non-admin users see their outlet's warehouses + MAIN (for transfers/demands reference)
  if (!ADMIN_ROLES.includes(req.user?.role || '')) {
    if (req.user?.outletId) {
      where.OR = [
        { outletId: req.user.outletId },
        { type: 'MAIN' },
      ];
    } else {
      // No outlet assigned (main warehouse staff) → only MAIN type
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

  if (!warehouse) throw ApiError.notFound('Warehouse not found');
  res.json(ApiResponse.success(warehouse));
});

/** GET /api/warehouses/:id/stock */
export const getWarehouseStock = asyncHandler(async (req: Request, res: Response) => {
  const { id } = req.params;
  const { categoryId, search, lowStockOnly } = req.query;

  const warehouse = await prisma.warehouse.findUnique({ where: { id } });
  if (!warehouse) throw ApiError.notFound('Warehouse not found');

  const where: any = { warehouseId: id };

  const stocks = await prisma.warehouseStock.findMany({
    where,
    include: {
      ingredient: {
        include: {
          unit: { select: { id: true, name: true, symbol: true } },
          category: { select: { id: true, name: true } },
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
      purchasePrice: s.ingredient.purchasePrice ? Number(s.ingredient.purchasePrice) : null,
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

/** GET /api/warehouses/:id/consumption?limit=50 */
export const getWarehouseConsumption = asyncHandler(async (req: Request, res: Response) => {
  const { id } = req.params;
  const limit = Math.min(Number(req.query.limit) || 50, 200);

  const warehouse = await prisma.warehouse.findUnique({ where: { id } });
  if (!warehouse) throw ApiError.notFound('Warehouse not found');

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
  const { name, code, type, outletId, managerId } = req.body;

  if (!name?.trim()) throw ApiError.badRequest('Warehouse name is required');
  if (!type) throw ApiError.badRequest('Warehouse type is required');

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
  const { name, code, outletId, managerId, isActive } = req.body;

  const existing = await prisma.warehouse.findUnique({ where: { id } });
  if (!existing) throw ApiError.notFound('Warehouse not found');

  if (code && code !== existing.code) {
    const codeTaken = await prisma.warehouse.findUnique({ where: { code } });
    if (codeTaken) throw ApiError.conflict('A warehouse with this code already exists');
  }

  const warehouse = await prisma.warehouse.update({
    where: { id },
    data: {
      ...(name && { name: name.trim() }),
      ...(code !== undefined && { code: code?.trim() || existing.code }),
      ...(outletId !== undefined && { outletId: outletId || null }),
      ...(managerId !== undefined && { managerId: managerId || null }),
      ...(isActive !== undefined && { isActive }),
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
