import type { Request } from 'express';
import { ApiError } from '../utils/ApiError.js';

/**
 * Derives the effective outlet filter for a request.
 *
 *   null   → no outlet filter (Super Admin viewing "All Outlets")
 *   string → restrict to this outlet id
 *
 * Super Admin may target any outlet via the `X-Outlet-Id` header (or
 * `?outletId=`); the value `'all'` (or no value) means "see everything".
 * Every other role is FORCED to their own `user.outletId` — any client-sent
 * outlet value is ignored, so a non-super-admin cannot read or write another
 * branch's data.
 */
export function resolveOutletScope(req: Request): string | null {
  const rawHeader = req.headers['x-outlet-id'];
  const headerVal = Array.isArray(rawHeader) ? rawHeader[0] : rawHeader;
  const rawQuery = req.query?.outletId;
  const queryVal = typeof rawQuery === 'string' ? rawQuery : undefined;
  const requested = headerVal || queryVal;

  const role = req.user?.role;
  if (role === 'Super Admin') {
    if (!requested || requested === 'all') return null;
    return requested;
  }
  // Everyone else: pinned to their own outlet (header ignored).
  return req.user?.outletId ?? null;
}

/**
 * Returns the outlet id to stamp on a NEW outlet-owned row.
 *   warehouseOutletId given (truthy) → use it (the stock's physical outlet)
 *   else → the acting user's scope (resolveOutletScope)
 *   if that is null (Super Admin on "All", no warehouse) → 400, must pick an outlet.
 * A non-super-admin always resolves to their own outlet (never reaches the throw
 * unless they have no assigned outlet — the documented pre-existing edge).
 */
export function resolveCreateOutlet(req: Request, warehouseOutletId?: string | null): string {
  if (warehouseOutletId) return warehouseOutletId;
  const scope = resolveOutletScope(req);
  if (scope) return scope;
  throw ApiError.badRequest('Select a specific outlet before creating');
}
