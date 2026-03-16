/**
 * Role-based Authorization Middleware (Placeholder for Phase 1)
 *
 * This file provides the structure for authorization middleware.
 * Full implementation will be done in Phase 1: Authentication & Users
 */

import type { Request, Response, NextFunction } from 'express';
import { ApiError } from '../utils/ApiError.js';

/**
 * Role permissions mapping (from frontend AuthContext)
 * Each role has access to specific routes/features
 */
export const rolePermissions: Record<string, string[]> = {
  'Super Admin': ['*'],
  'Admin': ['*'],
  'Manager': [
    'dashboard',
    'analytics',
    'pos',
    'kitchens',
    'waiter',
    'order-status',
    'items',
    'stock',
    'sales',
    'customers',
    'purchases',
    'suppliers',
    'expenses',
    'transfers',
    'waste',
    'attendance',
    'reports',
    'sms',
  ],
  'Cashier': ['dashboard', 'pos', 'sales', 'customers', 'customer-dues'],
  'Waiter': ['waiter'],
  'Kitchen Staff': ['kitchens'],
};

/**
 * Creates middleware that checks if user has required role(s)
 *
 * Usage:
 * router.delete('/users/:id', authenticate, authorize(['Super Admin', 'Admin']), deleteUser);
 */
export const authorize = (allowedRoles: string[]) => {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (!req.user) {
      return next(ApiError.unauthorized('Authentication required'));
    }

    const userRole = req.user.role;

    // Check if user's role is in allowed roles
    if (!allowedRoles.includes(userRole)) {
      return next(
        ApiError.forbidden(`This action requires one of these roles: ${allowedRoles.join(', ')}`)
      );
    }

    next();
  };
};

/**
 * Creates middleware that checks if user has permission for a specific feature
 *
 * Usage:
 * router.get('/reports', authenticate, requirePermission('reports'), getReports);
 */
export const requirePermission = (permission: string) => {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (!req.user) {
      return next(ApiError.unauthorized('Authentication required'));
    }

    const userRole = req.user.role;
    const permissions = rolePermissions[userRole] || [];

    // Check if user has wildcard access or specific permission
    if (!permissions.includes('*') && !permissions.includes(permission)) {
      return next(ApiError.forbidden(`You don't have permission to access: ${permission}`));
    }

    next();
  };
};
