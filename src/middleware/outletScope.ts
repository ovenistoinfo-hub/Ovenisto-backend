import type { Request } from 'express';

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
