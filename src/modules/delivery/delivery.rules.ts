/**
 * Delivery business rules: order status normalization, dispatch readiness,
 * and rider assignment transitions.
 * Pure and unit-tested — no DB or side effects.
 */

export const RIDER_TRANSITIONS: Record<string, string[]> = {
  pending: ['accepted'],
  accepted: ['dispatched'],
  dispatched: ['delivered', 'returned'],
};

/**
 * Normalizes an order status string to lowercase.
 * Returns empty string if null or undefined.
 */
export function normalizeOrderStatus(s: string | null | undefined): string {
  if (!s) return '';
  return s.trim().toLowerCase();
}

/**
 * Checks whether an order status allows dispatching.
 * Only 'ready' or 'completed' (case-insensitive) are allowed.
 */
export function isOrderReadyForDispatch(orderStatus: string | null | undefined): boolean {
  const normalized = normalizeOrderStatus(orderStatus);
  return normalized === 'ready' || normalized === 'completed';
}

/**
 * Checks whether a delivery assignment can be dispatched.
 * Requires:
 * - assignment status is 'accepted' (case-insensitive)
 * - order status is ready or completed
 */
export function canDispatch(
  orderStatus: string | null | undefined,
  assignmentStatus: string | null | undefined
): boolean {
  if (!assignmentStatus) return false;
  if (assignmentStatus.trim().toLowerCase() !== 'accepted') return false;
  return isOrderReadyForDispatch(orderStatus);
}

/**
 * Checks whether a transition between assignment statuses is allowed for a Rider.
 * Allowed transitions:
 * - pending -> accepted
 * - accepted -> dispatched
 * - dispatched -> delivered
 * - dispatched -> returned
 */
export function isRiderTransitionAllowed(
  from: string | null | undefined,
  to: string | null | undefined
): boolean {
  if (!from || !to) return false;
  const fromNorm = from.trim().toLowerCase();
  const toNorm = to.trim().toLowerCase();
  const allowed = RIDER_TRANSITIONS[fromNorm];
  if (!allowed) return false;
  return allowed.includes(toNorm);
}
