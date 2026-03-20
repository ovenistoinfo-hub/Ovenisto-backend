/**
 * Settings Controller
 * Handles retrieving and updating the restaurant settings
 */

import type { Request, Response } from 'express';
import { prisma } from '../../config/database.js';
import { ApiResponse } from '../../utils/ApiResponse.js';
import { ApiError } from '../../utils/ApiError.js';
import { asyncHandler } from '../../utils/asyncHandler.js';

/**
 * GET /api/settings
 * Fetch global or outlet-specific settings.
 */
export const getSettings = asyncHandler(async (req: Request, res: Response) => {
  const userOutletId = (req as any).user?.outletId;
  
  let settings;
  if (userOutletId) {
    settings = await prisma.settings.findFirst({
      where: { outletId: userOutletId },
    });
  }

  // Fallback to first settings instance available if no outlet specified or found
  if (!settings) {
    settings = await prisma.settings.findFirst();
  }

  if (!settings) {
    throw ApiError.notFound('Restaurant settings not configured yet');
  }

  res.json(ApiResponse.success({ ...settings, taxRate: Number(settings.taxRate) }));
});

/**
 * PUT /api/settings
 * Update existing settings
 */
export const updateSettings = asyncHandler(async (req: Request, res: Response) => {
  const userOutletId = (req as any).user?.outletId;
  
  let existingSettings;
  if (userOutletId) {
    existingSettings = await prisma.settings.findFirst({
      where: { outletId: userOutletId },
    });
  }

  if (!existingSettings) {
    existingSettings = await prisma.settings.findFirst();
  }

  if (!existingSettings) {
    throw ApiError.notFound('Restaurant settings not found to update');
  }

  const updatedSettings = await prisma.settings.update({
    where: { id: existingSettings.id },
    data: req.body,
  });

  res.json(ApiResponse.success(updatedSettings, 'Settings updated successfully'));
});
