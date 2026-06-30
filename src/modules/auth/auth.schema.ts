/**
 * Auth & User Zod Validation Schemas
 */

import { z } from 'zod';

// ============================================
// Auth Schemas
// ============================================

export const loginSchema = z.object({
  email: z.string().email('Invalid email format'),
  password: z.string().min(1, 'Password is required'),
  rememberMe: z.boolean().optional().default(false),
});

export const updateProfileSchema = z.object({
  name: z.string().min(1, 'Name is required').max(100).optional(),
  phone: z.string().max(20).optional().nullable(),
  avatar: z.string().optional().nullable(),
});

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1, 'Current password is required'),
  newPassword: z
    .string()
    .min(6, 'New password must be at least 6 characters')
    .max(100),
});

export const refreshTokenSchema = z.object({
  refreshToken: z.string().min(1, 'Refresh token is required'),
});

// ============================================
// User Schemas
// ============================================

const userRoleEnum = z.enum([
  'Super Admin',
  'Admin',
  'Manager',
  'Cashier',
  'Waiter',
  'Kitchen Staff',
  'Kitchen Manager',
  'Floor Manager',
  'Delivery Manager',
  'Store Manager',
  'Accountant',
  'Rider',
  'Customer Screen',
]);

export const createUserSchema = z.object({
  name: z.string().min(1, 'Name is required').max(100),
  email: z.string().email('Invalid email format').max(100),
  password: z.string().min(6, 'Password must be at least 6 characters').max(100),
  phone: z.string().max(20).optional().nullable(),
  role: userRoleEnum,
  branch: z.string().max(100).optional().nullable(),
  outletId: z.string().uuid().optional().nullable(),
  avatar: z.string().optional().nullable(),
  status: z.enum(['active', 'inactive']).optional().default('active'),
  employeeId: z.string().uuid().optional().nullable(),
});

export const updateUserSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  email: z.string().email().max(100).optional(),
  password: z.string().min(6).max(100).optional(),
  phone: z.string().max(20).optional().nullable(),
  role: userRoleEnum.optional(),
  branch: z.string().max(100).optional().nullable(),
  outletId: z.string().uuid().optional().nullable(),
  avatar: z.string().optional().nullable(),
  status: z.enum(['active', 'inactive']).optional(),
});

export const userQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(500).default(20),
  search: z.string().optional(),
  role: userRoleEnum.optional(),
  status: z.enum(['active', 'inactive']).optional(),
  outletId: z.string().uuid().optional(),
});

// Type exports
export type LoginInput = z.infer<typeof loginSchema>;
export type UpdateProfileInput = z.infer<typeof updateProfileSchema>;
export type ChangePasswordInput = z.infer<typeof changePasswordSchema>;
export type CreateUserInput = z.infer<typeof createUserSchema>;
export type UpdateUserInput = z.infer<typeof updateUserSchema>;
export type UserQueryInput = z.infer<typeof userQuerySchema>;
