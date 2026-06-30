/**
 * User Controller
 * Handles user CRUD operations (Admin+ only)
 */

import type { Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import { prisma } from '../../config/database.js';
import { ApiResponse } from '../../utils/ApiResponse.js';
import { ApiError } from '../../utils/ApiError.js';
import { asyncHandler } from '../../utils/asyncHandler.js';
import type { CreateUserInput, UpdateUserInput, UserQueryInput } from '../auth/auth.schema.js';
import { UserRole } from '@prisma/client';
import { resolveOutletScope } from '../../middleware/outletScope.js';

// Map frontend role string to Prisma enum
function toPrismaRole(role: string): UserRole {
  const map: Record<string, UserRole> = {
    'Super Admin': UserRole.SUPER_ADMIN,
    'Admin': UserRole.ADMIN,
    'Manager': UserRole.MANAGER,
    'Cashier': UserRole.CASHIER,
    'Waiter': UserRole.WAITER,
    'Kitchen Staff': UserRole.KITCHEN,
    'Kitchen Manager': UserRole.KITCHEN_MANAGER,
    'Floor Manager': UserRole.FLOOR_MANAGER,
    'Delivery Manager': UserRole.DELIVERY_MANAGER,
    'Store Manager': UserRole.STORE_MANAGER,
    'Accountant': UserRole.ACCOUNTANT,
    'Rider': UserRole.RIDER,
    'Customer Screen': UserRole.CUSTOMER_SCREEN,
  };
  return map[role] || UserRole.CASHIER;
}

// Map Prisma enum to frontend string
function toFrontendRole(role: string): string {
  const map: Record<string, string> = {
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
  return map[role] || role;
}

// Map user for frontend response (strip passwordHash, convert role, convert Decimals)
function mapUser(user: any) {
  const { passwordHash, ...rest } = user;
  return {
    ...rest,
    role: toFrontendRole(rest.role),
  };
}

/**
 * GET /api/users
 */
export const getUsers = asyncHandler(async (req: Request, res: Response) => {
  const { page, limit, search, role, status, outletId } = req.query as unknown as UserQueryInput;
  const skip = (page - 1) * limit;

  const where: any = {};

  if (search) {
    where.OR = [
      { name: { contains: search, mode: 'insensitive' } },
      { email: { contains: search, mode: 'insensitive' } },
      { phone: { contains: search } },
    ];
  }

  if (role) {
    where.role = toPrismaRole(role);
  }

  if (status) {
    where.status = status;
  }

  const scope = resolveOutletScope(req);
  if (scope) {
    where.outletId = scope;
  } else if (outletId) {
    where.outletId = outletId;
  }

  const [users, total] = await Promise.all([
    prisma.user.findMany({
      where,
      skip,
      take: limit,
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        name: true,
        email: true,
        phone: true,
        role: true,
        branch: true,
        outletId: true,
        avatar: true,
        status: true,
        lastLogin: true,
        createdAt: true,
        outlet: { select: { id: true, name: true, code: true } },
      },
    }),
    prisma.user.count({ where }),
  ]);

  const mappedUsers = users.map(mapUser);
  res.json(ApiResponse.paginated(mappedUsers, page, limit, total));
});

/**
 * GET /api/users/:id
 */
export const getUser = asyncHandler(async (req: Request, res: Response) => {
  const user = await prisma.user.findUnique({
    where: { id: req.params.id },
    select: {
      id: true,
      name: true,
      email: true,
      phone: true,
      role: true,
      branch: true,
      outletId: true,
      avatar: true,
      status: true,
      lastLogin: true,
      createdAt: true,
      outlet: { select: { id: true, name: true, code: true } },
    },
  });

  if (!user) {
    throw ApiError.notFound('User not found');
  }

  res.json(ApiResponse.success(mapUser(user)));
});

/**
 * POST /api/users
 */
export const createUser = asyncHandler(async (req: Request, res: Response) => {
  const input = req.body as CreateUserInput;

  // Check if email already exists
  const existing = await prisma.user.findUnique({ where: { email: input.email.toLowerCase() } });
  if (existing) {
    throw ApiError.conflict('A user with this email already exists');
  }

  // Hash password
  const passwordHash = await bcrypt.hash(input.password, 10);

  const user = await prisma.user.create({
    data: {
      name: input.name,
      email: input.email.toLowerCase(),
      passwordHash,
      phone: input.phone ?? null,
      role: toPrismaRole(input.role),
      branch: input.branch ?? null,
      outletId: input.outletId ?? null,
      avatar: input.avatar ?? null,
      status: input.status ?? 'active',
    },
    select: {
      id: true,
      name: true,
      email: true,
      phone: true,
      role: true,
      branch: true,
      outletId: true,
      avatar: true,
      status: true,
      createdAt: true,
      outlet: { select: { id: true, name: true, code: true } },
    },
  });

  // Link employee profile if employeeId provided
  const employeeId = (req.body as any).employeeId as string | undefined;
  if (employeeId) {
    await prisma.employee.update({
      where: { id: employeeId },
      data: { userId: user.id },
    });
  }

  // Auto-create DeliveryRider profile for Rider role
  if (input.role === 'Rider') {
    await prisma.deliveryRider.upsert({
      where: { userId: user.id },
      update: { name: user.name, phone: user.phone ?? null },
      create: { userId: user.id, name: user.name, phone: user.phone ?? null, status: 'available' },
    });
  }

  res.status(201).json(ApiResponse.created(mapUser(user), 'User created successfully'));
});

/**
 * GET /api/users/unlinked-employees
 * Returns employees that have no portal user account yet (userId is null)
 */
export const getUnlinkedEmployees = asyncHandler(async (req: Request, res: Response) => {
  const employees = await prisma.employee.findMany({
    where: { userId: null, status: 'active' },
    orderBy: { firstName: 'asc' },
    select: {
      id: true,
      firstName: true,
      lastName: true,
      email: true,
      phone: true,
      designation: true,
      outletId: true,
      outlet: { select: { id: true, name: true } },
    },
  });
  res.json(ApiResponse.success(employees));
});

/**
 * PUT /api/users/:id
 */
export const updateUser = asyncHandler(async (req: Request, res: Response) => {
  const { id } = req.params;
  const input = req.body as UpdateUserInput;

  // Check user exists
  const existing = await prisma.user.findUnique({ where: { id } });
  if (!existing) {
    throw ApiError.notFound('User not found');
  }

  // If email is being changed, check it's not taken
  if (input.email && input.email.toLowerCase() !== existing.email) {
    const emailTaken = await prisma.user.findUnique({
      where: { email: input.email.toLowerCase() },
    });
    if (emailTaken) {
      throw ApiError.conflict('A user with this email already exists');
    }
  }

  // Build update data
  const updateData: any = {};
  if (input.name !== undefined) updateData.name = input.name;
  if (input.email !== undefined) updateData.email = input.email.toLowerCase();
  if (input.phone !== undefined) updateData.phone = input.phone;
  if (input.role !== undefined) updateData.role = toPrismaRole(input.role);
  if (input.branch !== undefined) updateData.branch = input.branch;
  if (input.outletId !== undefined) updateData.outletId = input.outletId;
  if (input.avatar !== undefined) updateData.avatar = input.avatar;
  if (input.status !== undefined) updateData.status = input.status;

  // Hash new password if provided
  if (input.password) {
    updateData.passwordHash = await bcrypt.hash(input.password, 10);
  }

  const user = await prisma.user.update({
    where: { id },
    data: updateData,
    select: {
      id: true,
      name: true,
      email: true,
      phone: true,
      role: true,
      branch: true,
      outletId: true,
      avatar: true,
      status: true,
      lastLogin: true,
      createdAt: true,
      outlet: { select: { id: true, name: true, code: true } },
    },
  });

  // Sync DeliveryRider profile: create if role became Rider, update name/phone if already Rider
  const newRole = updateData.role ?? existing.role;
  if (newRole === 'RIDER') {
    await prisma.deliveryRider.upsert({
      where: { userId: id },
      update: {
        ...(updateData.name  !== undefined && { name:  updateData.name }),
        ...(updateData.phone !== undefined && { phone: updateData.phone }),
      },
      create: { userId: id, name: user.name, phone: user.phone ?? null, status: 'available' },
    });
  }

  res.json(ApiResponse.success(mapUser(user), 'User updated successfully'));
});

/**
 * DELETE /api/users/:id
 * Soft deletes (deactivates) the user
 */
export const deleteUser = asyncHandler(async (req: Request, res: Response) => {
  const { id } = req.params;

  // Prevent self-deletion
  if (req.user!.id === id) {
    throw ApiError.badRequest('You cannot deactivate your own account');
  }

  const user = await prisma.user.findUnique({ where: { id } });
  if (!user) {
    throw ApiError.notFound('User not found');
  }

  await prisma.user.update({
    where: { id },
    data: { status: 'inactive' },
  });

  res.json(ApiResponse.success(null, 'User deactivated successfully'));
});
