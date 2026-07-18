/**
 * Table Controller
 * CRUD for RestaurantTable model
 */

import type { Request, Response } from 'express';
import { prisma } from '../../config/database.js';
import { ApiResponse } from '../../utils/ApiResponse.js';
import { ApiError } from '../../utils/ApiError.js';
import { asyncHandler } from '../../utils/asyncHandler.js';
import { resolveOutletScope, resolveCreateOutlet } from '../../middleware/outletScope.js';
import { emitTableEvent } from '../../socket.js';

/** GET /api/tables */
export const getTables = asyncHandler(async (req: Request, res: Response) => {
  const { floor, status } = req.query;

  const where: any = {};
  if (floor) where.floor = String(floor);
  if (status) where.status = String(status);
  const scope = resolveOutletScope(req);
  if (scope) where.outletId = scope;

  const tables = await prisma.restaurantTable.findMany({
    where,
    orderBy: [{ floor: 'asc' }, { number: 'asc' }],
  });

  res.json(ApiResponse.success(tables));
});

/** POST /api/tables */
export const createTable = asyncHandler(async (req: Request, res: Response) => {
  const { number, capacity, floor, shape, status } = req.body;
  if (!number?.toString().trim()) throw ApiError.badRequest('Table number is required');

  const outletId = resolveCreateOutlet(req);
  const existing = await prisma.restaurantTable.findFirst({ where: { number: String(number), outletId } });
  if (existing) throw ApiError.badRequest(`Table ${number} already exists`);

  const table = await prisma.restaurantTable.create({
    data: {
      number: String(number).trim(),
      capacity: capacity ?? 4,
      floor: floor || null,
      shape: shape || null,
      status: status ?? 'available',
      outletId,
    },
  });

  emitTableEvent('table:created', table, [table.outletId]);

  res.status(201).json(ApiResponse.created(table, 'Table created'));
});

/** PUT /api/tables/:id */
export const updateTable = asyncHandler(async (req: Request, res: Response) => {
  const { id } = req.params;
  const { number, capacity, floor, shape, status, currentOrderId } = req.body;

  const existing = await prisma.restaurantTable.findUnique({ where: { id } });
  if (!existing) throw ApiError.notFound('Table not found');
  const scope = resolveOutletScope(req);
  if (scope && existing.outletId !== scope) throw ApiError.notFound('Table not found');

  // Check uniqueness if number is being changed (within the same outlet)
  if (number !== undefined && String(number) !== existing.number) {
    const conflict = await prisma.restaurantTable.findFirst({ where: { number: String(number), outletId: existing.outletId } });
    if (conflict) throw ApiError.badRequest(`Table ${number} already exists`);
  }

  const table = await prisma.restaurantTable.update({
    where: { id },
    data: {
      ...(number !== undefined && { number: String(number).trim() }),
      ...(capacity !== undefined && { capacity }),
      ...(floor !== undefined && { floor: floor || null }),
      ...(shape !== undefined && { shape: shape || null }),
      ...(status !== undefined && { status }),
      ...(currentOrderId !== undefined && { currentOrderId: currentOrderId || null }),
    },
  });

  emitTableEvent('table:updated', table, [table.outletId]);

  res.json(ApiResponse.success(table, 'Table updated'));
});

/** DELETE /api/tables/:id */
export const deleteTable = asyncHandler(async (req: Request, res: Response) => {
  const existing = await prisma.restaurantTable.findUnique({ where: { id: req.params.id } });
  if (!existing) throw ApiError.notFound('Table not found');
  const scope = resolveOutletScope(req);
  if (scope && existing.outletId !== scope) throw ApiError.notFound('Table not found');

  await prisma.restaurantTable.delete({ where: { id: req.params.id } });
  emitTableEvent('table:deleted', existing, [existing.outletId]);
  res.json(ApiResponse.success(null, 'Table deleted'));
});
