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
