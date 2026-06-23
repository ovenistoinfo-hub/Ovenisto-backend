/**
 * ProductionItem Controller
 * CRUD for standalone production items (e.g. dough types, sauces) used in productions.
 */
import type { Request, Response } from 'express';
import { prisma } from '../../config/database.js';
import { ApiResponse } from '../../utils/ApiResponse.js';
import { ApiError } from '../../utils/ApiError.js';
import { asyncHandler } from '../../utils/asyncHandler.js';

/** GET /api/production-items */
export const getProductionItems = asyncHandler(async (_req: Request, res: Response) => {
  const items = await prisma.productionItem.findMany({
    where: { isActive: true },
    orderBy: { name: 'asc' },
  });
  res.json(ApiResponse.success(items));
});

/** POST /api/production-items */
export const createProductionItem = asyncHandler(async (req: Request, res: Response) => {
  const { name, unit, shelfLifeHours } = req.body;
  if (!name || !unit) throw ApiError.badRequest('name and unit are required');

  const item = await prisma.productionItem.create({
    data: {
      name: String(name).trim(),
      unit: String(unit).trim(),
      shelfLifeHours: shelfLifeHours != null ? Number(shelfLifeHours) : null,
    },
  });
  res.status(201).json(ApiResponse.created(item));
});

/** PUT /api/production-items/:id */
export const updateProductionItem = asyncHandler(async (req: Request, res: Response) => {
  const { id } = req.params;
  const { name, unit, shelfLifeHours } = req.body;

  const existing = await prisma.productionItem.findUnique({ where: { id } });
  if (!existing || !existing.isActive) throw ApiError.notFound('Production item not found');

  const item = await prisma.productionItem.update({
    where: { id },
    data: {
      ...(name != null && { name: String(name).trim() }),
      ...(unit != null && { unit: String(unit).trim() }),
      ...(shelfLifeHours !== undefined && {
        shelfLifeHours: shelfLifeHours != null ? Number(shelfLifeHours) : null,
      }),
    },
  });
  res.json(ApiResponse.success(item));
});

/** DELETE /api/production-items/:id — soft delete */
export const deleteProductionItem = asyncHandler(async (req: Request, res: Response) => {
  const { id } = req.params;
  const existing = await prisma.productionItem.findUnique({ where: { id } });
  if (!existing || !existing.isActive) throw ApiError.notFound('Production item not found');

  await prisma.productionItem.update({ where: { id }, data: { isActive: false } });
  res.json(ApiResponse.success(null, 'Production item deleted'));
});
