import { Prisma } from '@prisma/client';

export function requiresAcceptance(o: { type: string; orderSource: string | null }): boolean {
  return o.type === 'SELF_ORDER' || o.orderSource === 'website';
}

export function isAwaitingAcceptance(o: { type: string; orderSource: string | null; status: string; acceptedById: string | null }): boolean {
  return requiresAcceptance(o) && o.status === 'PENDING' && !o.acceptedById;
}

export const AWAITING_ACCEPTANCE_WHERE: Prisma.OrderWhereInput = {
  status: 'PENDING',
  acceptedById: null,
  OR: [{ type: 'SELF_ORDER' }, { orderSource: 'website' }],
};
