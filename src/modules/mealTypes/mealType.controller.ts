/**
 * Meal Type Controller
 * CRUD for meal service categories (Breakfast, Lunch, Dinner, etc.)
 */

import type { Request, Response } from 'express';
import { prisma } from '../../config/database.js';
import { ApiResponse } from '../../utils/ApiResponse.js';
import { ApiError } from '../../utils/ApiError.js';
import { asyncHandler } from '../../utils/asyncHandler.js';

/** GET /api/meal-types */
export const getMealTypes = asyncHandler(async (req: Request, res: Response) => {
  const { status } = req.query;
  const where: any = {};
  if (status) where.status = String(status);

  const mealTypes = await prisma.mealType.findMany({
    where,
    orderBy: { name: 'asc' },
  });
  res.json(ApiResponse.success(mealTypes));
});

/** POST /api/meal-types */
export const createMealType = asyncHandler(async (req: Request, res: Response) => {
  const { name, status } = req.body;
  if (!name?.trim()) throw ApiError.badRequest('Meal type name is required');

  const existing = await prisma.mealType.findFirst({
    where: { name: { equals: name.trim(), mode: 'insensitive' } },
  });
  if (existing) throw ApiError.conflict('A meal type with this name already exists');

  const mealType = await prisma.mealType.create({
    data: { name: name.trim(), status: status ?? 'active' },
  });
  res.status(201).json(ApiResponse.created(mealType, 'Meal type created'));
});

/** PUT /api/meal-types/:id */
export const updateMealType = asyncHandler(async (req: Request, res: Response) => {
  const { id } = req.params;
  const { name, status } = req.body;

  const existing = await prisma.mealType.findUnique({ where: { id } });
  if (!existing) throw ApiError.notFound('Meal type not found');

  if (name && name.trim() !== existing.name) {
    const nameTaken = await prisma.mealType.findFirst({
      where: { name: { equals: name.trim(), mode: 'insensitive' }, NOT: { id } },
    });
    if (nameTaken) throw ApiError.conflict('A meal type with this name already exists');
  }

  const mealType = await prisma.mealType.update({
    where: { id },
    data: {
      ...(name && { name: name.trim() }),
      ...(status && { status }),
    },
  });
  res.json(ApiResponse.success(mealType, 'Meal type updated'));
});

/** DELETE /api/meal-types/:id */
export const deleteMealType = asyncHandler(async (req: Request, res: Response) => {
  const { id } = req.params;

  const existing = await prisma.mealType.findUnique({ where: { id } });
  if (!existing) throw ApiError.notFound('Meal type not found');

  const usageCount = await prisma.foodMenuItem.count({
    where: { mealTypeIds: { has: id } },
  });
  if (usageCount > 0) {
    throw ApiError.badRequest(`Cannot delete — ${usageCount} menu item${usageCount > 1 ? 's' : ''} use this meal type`);
  }

  await prisma.mealType.delete({ where: { id } });
  res.json(ApiResponse.success(null, 'Meal type deleted'));
});
