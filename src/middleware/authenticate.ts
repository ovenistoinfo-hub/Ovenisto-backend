/**
 * JWT Authentication Middleware
 * Verifies JWT tokens and attaches user to request
 */

import type { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { ApiError } from '../utils/ApiError.js';
import { prisma } from '../config/database.js';
import { env } from '../config/env.js';
import type { JwtPayload } from '../types/index.js';

// Map Prisma UserRole enum to frontend-friendly string
const ROLE_MAP: Record<string, string> = {
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

// Extend Express Request type to include user
declare global {
  namespace Express {
    interface Request {
      user?: {
        id: string;
        name: string;
        email: string;
        role: string;
        outletId?: string | null;
      };
    }
  }
}

/**
 * Middleware to verify JWT token and attach user to request
 */
export const authenticate = async (
  req: Request,
  _res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      throw ApiError.unauthorized('No token provided');
    }

    const token = authHeader.split(' ')[1];

    if (!token) {
      throw ApiError.unauthorized('Invalid token format');
    }

    // Verify JWT token
    let decoded: JwtPayload;
    try {
      decoded = jwt.verify(token, env.JWT_SECRET) as JwtPayload;
    } catch (err) {
      if (err instanceof jwt.TokenExpiredError) {
        throw ApiError.unauthorized('Token expired');
      }
      throw ApiError.unauthorized('Invalid token');
    }

    // Find user from database
    const user = await prisma.user.findUnique({
      where: { id: decoded.userId },
      select: {
        id: true,
        name: true,
        email: true,
        role: true,
        outletId: true,
        status: true,
      },
    });

    if (!user) {
      throw ApiError.unauthorized('User not found');
    }

    if (user.status !== 'active') {
      throw ApiError.unauthorized('Account is deactivated');
    }

    // Attach user to request (map Prisma enum role to frontend string)
    req.user = {
      id: user.id,
      name: user.name,
      email: user.email,
      role: ROLE_MAP[user.role] || user.role,
      outletId: user.outletId,
    };

    next();
  } catch (error) {
    next(error);
  }
};

/**
 * Optional authentication - attaches user if token exists, but doesn't require it
 */
export const optionalAuth = async (
  req: Request,
  _res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return next();
    }

    const token = authHeader.split(' ')[1];
    if (!token) {
      return next();
    }

    try {
      const decoded = jwt.verify(token, env.JWT_SECRET) as JwtPayload;
      const user = await prisma.user.findUnique({
        where: { id: decoded.userId },
        select: {
          id: true,
          name: true,
          email: true,
          role: true,
          outletId: true,
          status: true,
        },
      });

      if (user && user.status === 'active') {
        req.user = {
          id: user.id,
          name: user.name,
          email: user.email,
          role: ROLE_MAP[user.role] || user.role,
          outletId: user.outletId,
        };
      }
    } catch {
      // Token invalid, continue without user
    }

    next();
  } catch {
    next();
  }
};
