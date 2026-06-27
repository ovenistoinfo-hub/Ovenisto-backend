/**
 * Auth Controller
 * Handles login, logout, profile, token refresh
 */

import type { Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { prisma } from '../../config/database.js';
import { env } from '../../config/env.js';
import { ApiResponse } from '../../utils/ApiResponse.js';
import { ApiError } from '../../utils/ApiError.js';
import { asyncHandler } from '../../utils/asyncHandler.js';
import type { JwtPayload } from '../../types/index.js';
import type { LoginInput, UpdateProfileInput, ChangePasswordInput } from './auth.schema.js';

// Helper: map Prisma UserRole enum to frontend-friendly string
function mapRole(role: string): string {
  const roleMap: Record<string, string> = {
    SUPER_ADMIN: 'Super Admin',
    ADMIN: 'Admin',
    MANAGER: 'Manager',
    CASHIER: 'Cashier',
    WAITER: 'Waiter',
    KITCHEN: 'Kitchen Staff',
    KITCHEN_MANAGER: 'Kitchen Manager',
    FLOOR_MANAGER: 'Floor Manager',
    DELIVERY_MANAGER: 'Delivery Manager',
    STORE_MANAGER: 'Store Manager',
    ACCOUNTANT: 'Accountant',
    RIDER: 'Rider',
    CUSTOMER_SCREEN: 'Customer Screen',
  };
  return roleMap[role] || role;
}

// Helper: generate JWT access token
function generateAccessToken(userId: string, email: string, role: string, outletId?: string | null): string {
  const payload: JwtPayload = { userId, email, role, outletId: outletId ?? undefined };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return jwt.sign(payload, env.JWT_SECRET, { expiresIn: env.JWT_EXPIRES_IN } as any);
}

// Helper: generate refresh token (longer-lived)
function generateRefreshToken(userId: string): string {
  return jwt.sign({ userId, type: 'refresh' }, env.JWT_SECRET, { expiresIn: '30d' });
}

/**
 * POST /api/auth/login
 */
export const login = asyncHandler(async (req: Request, res: Response) => {
  const { email, password } = req.body as LoginInput;

  // Find user by email
  const user = await prisma.user.findUnique({
    where: { email: email.toLowerCase() },
    include: { outlet: { select: { id: true, name: true, code: true } } },
  });

  if (!user) {
    throw ApiError.unauthorized('Invalid email or password');
  }

  if (user.status !== 'active') {
    throw ApiError.unauthorized('Account is deactivated. Contact your administrator.');
  }

  // Verify password
  const isPasswordValid = await bcrypt.compare(password, user.passwordHash);
  if (!isPasswordValid) {
    throw ApiError.unauthorized('Invalid email or password');
  }

  // Generate tokens
  const role = mapRole(user.role);
  const accessToken = generateAccessToken(user.id, user.email, role, user.outletId);
  const refreshToken = generateRefreshToken(user.id);

  // Update last login
  await prisma.user.update({
    where: { id: user.id },
    data: { lastLogin: new Date() },
  });

  res.json(
    ApiResponse.success(
      {
        user: {
          id: user.id,
          name: user.name,
          email: user.email,
          role,
          phone: user.phone,
          branch: user.branch,
          avatar: user.avatar,
          outletId: user.outletId,
          outlet: user.outlet,
        },
        accessToken,
        refreshToken,
      },
      'Login successful'
    )
  );
});

/**
 * POST /api/auth/logout
 */
export const logout = asyncHandler(async (_req: Request, res: Response) => {
  // With JWT, logout is handled client-side by removing the token
  // For extra security, you could add token blacklisting here
  res.json(ApiResponse.success(null, 'Logged out successfully'));
});

/**
 * GET /api/auth/me
 */
export const getMe = asyncHandler(async (req: Request, res: Response) => {
  const user = await prisma.user.findUnique({
    where: { id: req.user!.id },
    select: {
      id: true,
      name: true,
      email: true,
      role: true,
      phone: true,
      branch: true,
      avatar: true,
      outletId: true,
      status: true,
      lastLogin: true,
      createdAt: true,
      hourlyRate: true,
      absencePenalty: true,
      outlet: { select: { id: true, name: true, code: true } },
    },
  });

  if (!user) {
    throw ApiError.notFound('User not found');
  }

  res.json(
    ApiResponse.success({
      ...user,
      role: mapRole(user.role),
      hourlyRate: user.hourlyRate != null ? Number(user.hourlyRate) : null,
      absencePenalty: user.absencePenalty != null ? Number(user.absencePenalty) : null,
    })
  );
});

/**
 * PUT /api/auth/me
 */
export const updateMe = asyncHandler(async (req: Request, res: Response) => {
  const updates = req.body as UpdateProfileInput;

  const user = await prisma.user.update({
    where: { id: req.user!.id },
    data: updates,
    select: {
      id: true,
      name: true,
      email: true,
      role: true,
      phone: true,
      branch: true,
      avatar: true,
      outletId: true,
      status: true,
    },
  });

  res.json(
    ApiResponse.success(
      { ...user, role: mapRole(user.role) },
      'Profile updated successfully'
    )
  );
});

/**
 * PUT /api/auth/change-password
 */
export const changePassword = asyncHandler(async (req: Request, res: Response) => {
  const { currentPassword, newPassword } = req.body as ChangePasswordInput;

  const user = await prisma.user.findUnique({
    where: { id: req.user!.id },
    select: { passwordHash: true },
  });

  if (!user) {
    throw ApiError.notFound('User not found');
  }

  const isValid = await bcrypt.compare(currentPassword, user.passwordHash);
  if (!isValid) {
    throw ApiError.badRequest('Current password is incorrect');
  }

  const newHash = await bcrypt.hash(newPassword, 10);
  await prisma.user.update({
    where: { id: req.user!.id },
    data: { passwordHash: newHash },
  });

  res.json(ApiResponse.success(null, 'Password changed successfully'));
});

/**
 * POST /api/auth/refresh
 */
export const refreshAccessToken = asyncHandler(async (req: Request, res: Response) => {
  const { refreshToken } = req.body;

  if (!refreshToken) {
    throw ApiError.badRequest('Refresh token is required');
  }

  let decoded: { userId: string; type: string };
  try {
    decoded = jwt.verify(refreshToken, env.JWT_SECRET) as { userId: string; type: string };
  } catch {
    throw ApiError.unauthorized('Invalid or expired refresh token');
  }

  if (decoded.type !== 'refresh') {
    throw ApiError.unauthorized('Invalid token type');
  }

  const user = await prisma.user.findUnique({
    where: { id: decoded.userId },
    select: { id: true, email: true, role: true, outletId: true, status: true },
  });

  if (!user || user.status !== 'active') {
    throw ApiError.unauthorized('User not found or deactivated');
  }

  const role = mapRole(user.role);
  const newAccessToken = generateAccessToken(user.id, user.email, role, user.outletId);
  const newRefreshToken = generateRefreshToken(user.id);

  res.json(
    ApiResponse.success({
      accessToken: newAccessToken,
      refreshToken: newRefreshToken,
    })
  );
});
