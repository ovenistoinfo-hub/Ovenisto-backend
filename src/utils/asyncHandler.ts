/**
 * Async Handler Wrapper
 * Wraps async route handlers to catch errors and pass them to error middleware
 */

import type { Request, Response, NextFunction, RequestHandler } from 'express';

type AsyncRequestHandler = (
  req: Request,
  res: Response,
  next: NextFunction
) => Promise<void | Response>;

/**
 * Wraps an async function to catch any errors and forward them to Express error handling
 *
 * Usage:
 * router.get('/users', asyncHandler(async (req, res) => {
 *   const users = await prisma.user.findMany();
 *   res.json(ApiResponse.success(users));
 * }));
 */
export const asyncHandler = (fn: AsyncRequestHandler): RequestHandler => {
  return (req: Request, res: Response, next: NextFunction): void => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
};
