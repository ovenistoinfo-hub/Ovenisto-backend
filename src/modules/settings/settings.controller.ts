/**
 * Settings Controller
 * Handles retrieving and updating the restaurant settings
 */

import type { Request, Response } from 'express';
import { prisma } from '../../config/database.js';
import { ApiResponse } from '../../utils/ApiResponse.js';
import { ApiError } from '../../utils/ApiError.js';
import { asyncHandler } from '../../utils/asyncHandler.js';
import { resolveOutletScope } from '../../middleware/outletScope.js';
import { getConfiguredPaymentMethods } from './settings.service.js';

/**
 * GET /api/settings
 * Fetch global or outlet-specific settings.
 */
export const getSettings = asyncHandler(async (req: Request, res: Response) => {
  const user = (req as any).user;

  if (req.headers.authorization?.startsWith('Bearer ') && !user) {
    throw ApiError.unauthorized('Session expired');
  }
  
  let settings;
  if (user) {
    if (user.role === 'Super Admin') {
      const scope = resolveOutletScope(req);
      if (scope) {
        settings = await prisma.settings.findFirst({
          where: { outletId: scope },
        });
      }
      if (!settings) {
        settings = await prisma.settings.findFirst();
        if (settings) {
          settings.paymentMethods = await getConfiguredPaymentMethods(null);
        }
      }
    } else {
      settings = await findCallerSettings(req);
    }
  } else {
    const qOutletId = req.query.outletId as string;
    if (qOutletId) {
      settings = await prisma.settings.findFirst({
        where: { outletId: qOutletId },
      });
    }
    if (!settings) {
      settings = await prisma.settings.findFirst();
    }
  }

  if (!settings) {
    throw ApiError.notFound('Restaurant settings not configured yet');
  }

  res.json(ApiResponse.success({ ...settings, taxRate: Number(settings.taxRate) }));
});

async function findCallerSettings(req: Request) {
  const userOutletId = (req as any).user?.outletId;
  // By role, not only by a missing outlet: a Super Admin account can still carry an
  // outletId (admin@ovenisto.com is linked to DHA) and must not edit branch settings.
  if (!userOutletId || (req as any).user?.role === 'Super Admin') {
    throw ApiError.forbidden('Settings are per branch — sign in as that branch\'s Admin');
  }
  
  const settings = await prisma.settings.findFirst({
    where: { outletId: userOutletId },
  });
  if (!settings) {
    throw ApiError.notFound('Settings for your branch are not set up yet');
  }
  return settings;
}

/**
 * GET /api/settings/mine
 * Fetch caller's specific settings without falling back to another branch
 */
export const getMySettings = asyncHandler(async (req: Request, res: Response) => {
  const settings = await findCallerSettings(req);
  res.json(ApiResponse.success({ ...settings, taxRate: Number(settings.taxRate) }));
});

/**
 * PUT /api/settings
 * Update existing settings
 */
export const updateSettings = asyncHandler(async (req: Request, res: Response) => {
  const existingSettings = await findCallerSettings(req);

  const updatedSettings = await prisma.settings.update({
    where: { id: existingSettings.id },
    data: req.body,
  });

  res.json(ApiResponse.success(updatedSettings, 'Settings updated successfully'));
});
