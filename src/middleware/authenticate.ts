/**
 * JWT Authentication Middleware (Placeholder for Phase 1)
 *
 * This file provides the structure for authentication middleware.
 * Full implementation will be done in Phase 1: Authentication & Users
 */

import type { Request, Response, NextFunction } from 'express';
import { ApiError } from '../utils/ApiError.js';

// Extend Express Request type to include user
declare global {
  namespace Express {
    interface Request {
      user?: {
        id: string;
        email: string;
        role: string;
        outletId?: string;
      };
    }
  }
}

/**
 * Middleware to verify JWT token and attach user to request
 * TODO: Implement in Phase 1
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

    // TODO: Verify JWT token and attach user to request
    // const decoded = jwt.verify(token, env.JWT_SECRET);
    // const user = await prisma.user.findUnique({ where: { id: decoded.userId } });
    // req.user = user;

    // Placeholder - Remove in Phase 1
    throw ApiError.unauthorized('Authentication not yet implemented');
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
      // No token, continue without user
      return next();
    }

    // TODO: Implement in Phase 1
    next();
  } catch (_error) {
    // Token invalid, continue without user
    next();
  }
};
