/**
 * Zod Validation Middleware Factory
 */

import type { Request, Response, NextFunction } from 'express';
import { z, ZodError, ZodSchema } from 'zod';
import { ApiError } from '../utils/ApiError.js';

interface ValidationSchemas {
  body?: ZodSchema;
  query?: ZodSchema;
  params?: ZodSchema;
}

/**
 * Creates middleware that validates request data against Zod schemas
 *
 * Usage:
 * router.post('/users', validateRequest({
 *   body: z.object({
 *     name: z.string(),
 *     email: z.string().email(),
 *   })
 * }), createUser);
 */
export const validateRequest = (schemas: ValidationSchemas) => {
  return async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
    try {
      // Validate body
      if (schemas.body) {
        req.body = await schemas.body.parseAsync(req.body);
      }

      // Validate query parameters
      if (schemas.query) {
        req.query = await schemas.query.parseAsync(req.query);
      }

      // Validate URL parameters
      if (schemas.params) {
        req.params = await schemas.params.parseAsync(req.params);
      }

      next();
    } catch (error) {
      if (error instanceof ZodError) {
        const errors = error.errors.map((e) => ({
          field: e.path.join('.'),
          message: e.message,
        }));
        next(ApiError.validationError('Validation failed', errors));
      } else {
        next(error);
      }
    }
  };
};

/**
 * Common validation schemas that can be reused
 */
export const commonSchemas = {
  uuid: z.string().uuid('Invalid UUID format'),
  pagination: z.object({
    page: z.coerce.number().int().positive().default(1),
    limit: z.coerce.number().int().positive().max(100).default(20),
  }),
  dateRange: z.object({
    startDate: z.coerce.date().optional(),
    endDate: z.coerce.date().optional(),
  }),
};
