/**
 * Notifications Controller
 * Device token registration and removal for push notifications.
 */

import type { Request, Response } from 'express';
import { prisma } from '../../config/database.js';
import { ApiResponse } from '../../utils/ApiResponse.js';
import { ApiError } from '../../utils/ApiError.js';
import { asyncHandler } from '../../utils/asyncHandler.js';

/** POST /api/notifications/device-token — register/reassign an FCM token */
export const registerDeviceToken = asyncHandler(async (req: Request, res: Response) => {
  const { token, platform } = req.body;
  if (!token || typeof token !== 'string' || !token.trim()) {
    throw ApiError.badRequest('token is required');
  }

  const cleanToken = token.trim();
  const cleanPlatform = typeof platform === 'string' && platform.trim() ? platform.trim() : 'android';
  const userId = req.user!.id;

  const record = await prisma.deviceToken.upsert({
    where: { token: cleanToken },
    create: {
      userId,
      token: cleanToken,
      platform: cleanPlatform,
    },
    update: {
      userId,
      platform: cleanPlatform,
      updatedAt: new Date(),
    },
  });

  res.json(ApiResponse.success(record, 'Device token registered'));
});

/** DELETE /api/notifications/device-token — deregister an FCM token */
export const deleteDeviceToken = asyncHandler(async (req: Request, res: Response) => {
  const { token } = req.body;
  if (!token || typeof token !== 'string' || !token.trim()) {
    throw ApiError.badRequest('token is required');
  }

  const cleanToken = token.trim();
  const userId = req.user!.id;

  await prisma.deviceToken.deleteMany({
    where: {
      token: cleanToken,
      userId,
    },
  });

  res.json(ApiResponse.success(null, 'Device token deleted'));
});
