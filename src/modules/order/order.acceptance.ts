import { Prisma } from '@prisma/client';

export function requiresAcceptance(o: { type: string; orderSource: string | null }): boolean {
  return o.type === 'SELF_ORDER' || o.orderSource === 'website';
}

/** Roles that may accept or decline a WEBSITE order (done on Order Monitor). Self-orders keep their route's roles. */
export const WEBSITE_ORDER_APPROVER_ROLES = ['Super Admin', 'Admin', 'Manager', 'Delivery Manager'];

export function canApproveOrder(o: { orderSource: string | null }, role: string | undefined): boolean {
  return o.orderSource !== 'website' || WEBSITE_ORDER_APPROVER_ROLES.includes(role ?? '');
}

export function isAwaitingAcceptance(o: { type: string; orderSource: string | null; status: string; acceptedById: string | null }): boolean {
  return requiresAcceptance(o) && o.status === 'PENDING' && !o.acceptedById;
}

export const AWAITING_ACCEPTANCE_WHERE: Prisma.OrderWhereInput = {
  status: 'PENDING',
  acceptedById: null,
  OR: [{ type: 'SELF_ORDER' }, { orderSource: 'website' }],
};

/**
 * A website pickup (Take Away) is paid at the POS counter, not online. It is created with
 * `cashApproved: true`, so once COMPLETED every report counts it as revenue — while Cash Hub skips a
 * `Pending` payment and the money is on nobody's balance. Completing one is refused until paid.
 */
export const UNPAID_WEBSITE_PICKUP_MESSAGE = 'Collect payment for this website pickup on POS first';

export function isUnpaidWebsitePickup(o: { orderSource: string | null; type: string; paymentMethod: string | null }): boolean {
  if (o.orderSource !== 'website' || o.type !== 'TAKE_AWAY') return false;
  const pm = (o.paymentMethod ?? '').trim().toLowerCase();
  return pm === '' || pm === 'pending' || pm === 'unpaid';
}
