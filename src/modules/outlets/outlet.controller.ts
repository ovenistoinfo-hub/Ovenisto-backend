/**
 * Outlet Controller
 * Handles CRUD for outlets/branches
 */

import type { Request, Response } from 'express';
import { prisma } from '../../config/database.js';
import { ApiResponse } from '../../utils/ApiResponse.js';
import { ApiError } from '../../utils/ApiError.js';
import { asyncHandler } from '../../utils/asyncHandler.js';

/**
 * GET /api/outlets
 */
export const getOutlets = asyncHandler(async (_req: Request, res: Response) => {
  const outlets = await prisma.outlet.findMany({
    where: { isActive: true },
    orderBy: { createdAt: 'desc' },
    select: {
      id: true,
      name: true,
      code: true,
      address: true,
      city: true,
      phone: true,
      email: true,
      isActive: true,
      createdAt: true,
      _count: { select: { users: true } },
    },
  });

  res.json(ApiResponse.success(outlets));
});

/**
 * GET /api/outlets/:id
 */
export const getOutlet = asyncHandler(async (req: Request, res: Response) => {
  const outlet = await prisma.outlet.findUnique({
    where: { id: req.params.id },
    include: {
      _count: { select: { users: true } },
    },
  });

  if (!outlet) {
    throw ApiError.notFound('Outlet not found');
  }

  res.json(ApiResponse.success(outlet));
});

/**
 * POST /api/outlets
 */
export const createOutlet = asyncHandler(async (req: Request, res: Response) => {
  const { name, code, address, city, phone, email } = req.body;

  if (!name || !code) {
    throw ApiError.badRequest('Name and code are required');
  }

  const existing = await prisma.outlet.findUnique({ where: { code } });
  if (existing) {
    throw ApiError.conflict('An outlet with this code already exists');
  }

  const outlet = await prisma.outlet.create({
    data: { name, code, address, city, phone, email },
  });

  res.status(201).json(ApiResponse.created(outlet, 'Outlet created successfully'));
});

/**
 * PUT /api/outlets/:id
 */
export const updateOutlet = asyncHandler(async (req: Request, res: Response) => {
  const { id } = req.params;
  const { name, code, address, city, phone, email, isActive } = req.body;

  const existing = await prisma.outlet.findUnique({ where: { id } });
  if (!existing) {
    throw ApiError.notFound('Outlet not found');
  }

  if (code && code !== existing.code) {
    const codeTaken = await prisma.outlet.findUnique({ where: { code } });
    if (codeTaken) {
      throw ApiError.conflict('An outlet with this code already exists');
    }
  }

  const outlet = await prisma.outlet.update({
    where: { id },
    data: { name, code, address, city, phone, email, isActive },
  });

  res.json(ApiResponse.success(outlet, 'Outlet updated successfully'));
});

/**
 * DELETE /api/outlets/:id (soft delete)
 */
export const deleteOutlet = asyncHandler(async (req: Request, res: Response) => {
  const { id } = req.params;

  const outlet = await prisma.outlet.findUnique({ where: { id } });
  if (!outlet) {
    throw ApiError.notFound('Outlet not found');
  }

  await prisma.outlet.update({
    where: { id },
    data: { isActive: false },
  });

  res.json(ApiResponse.success(null, 'Outlet deactivated successfully'));
});
