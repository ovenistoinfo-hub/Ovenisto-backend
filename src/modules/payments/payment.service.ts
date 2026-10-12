// Website online payment (Safepay): the DB side. Decisions are the pure rules in payment.rules.ts;
// the gateway calls are in safepay.ts.
import type { Request } from 'express';
import { Prisma } from '@prisma/client';
import { prisma } from '../../config/database.js';
import { env } from '../../config/env.js';
import { ApiError } from '../../utils/ApiError.js';
import { emitOrderEvent } from '../../socket.js';
import { mapOrderOut } from '../order/order.controller.js';
import { readSafepayConfig, createTracker, buildCheckoutUrl } from './safepay.js';
import {
  ONLINE_PAYMENT_METHOD, PAYMENT_WINDOW_MS, PAYMENT_EXPIRED_REASON, decideConfirm, refundsDueForOrder,
  resolveReturnOrigin, toPaymentLike, type RefundReason,
} from './payment.rules.js';

/** Null when the server has no (or incomplete) Safepay keys: "Pay online" is then never offered. */
export const safepayConfig = readSafepayConfig(process.env);

const allowedOrigins = env.CORS_ORIGIN.split(',').map((o) => o.trim());

/** The website origin to send the customer back to after checkout (the request's Origin, if allowed). */
export const returnOriginOf = (req: Request) => resolveReturnOrigin(req.get('origin'), allowedOrigins);

/** This API's public base URL (`trust proxy` makes req.protocol https behind Railway). */
export const apiBaseOf = (req: Request) => `${req.protocol}://${req.get('host')}/api`;

const ORDER_EVENT_INCLUDE = {
  items: { include: { menuItem: { select: { category: { select: { name: true } } } } } },
} satisfies Prisma.OrderInclude;

/** Best effort: a failed read or socket emit after a committed change must not turn into a 500 (a webhook retry, a failed Mark refunded). */
async function emitOrder(orderId: string, event: 'order:created' | 'order:updated') {
  try {
    const order = await prisma.order.findUnique({ where: { id: orderId }, include: ORDER_EVENT_INCLUDE });
    if (order) emitOrderEvent(event, mapOrderOut(order));
  } catch (err) {
    console.error(`[payments] could not announce ${event} for order ${orderId}`, err);
  }
}

/** Starts a Safepay checkout for an order waiting for payment; returns the URL to send the customer to. */
export async function startPayment(
  order: { id: string; orderNumber: string; total: unknown },
  ctx: { returnOrigin: string; apiBase: string }
): Promise<string> {
  if (!safepayConfig) throw ApiError.conflict("Online payment isn't available right now");
  const amount = Number(order.total);
  const token = await createTracker(safepayConfig, amount);
  const payment = await prisma.orderPayment.create({
    data: { orderId: order.id, tracker: token, amount, returnOrigin: ctx.returnOrigin },
  });
  return buildCheckoutUrl(safepayConfig, {
    token,
    orderId: order.orderNumber,
    redirectUrl: `${ctx.apiBase}/payments/safepay/return?pid=${payment.id}`,
    cancelUrl: `${ctx.returnOrigin}/order/${order.id}?payment=cancelled`,
  });
}

/**
 * A verified Safepay confirmation (the return or the webhook). Idempotent, and the order row is locked
 * so the two arriving together act once.
 */
export async function confirmPayment(tracker: string): Promise<void> {
  const result = await prisma.$transaction(async (tx) => {
    const found = await tx.orderPayment.findUnique({ where: { tracker }, select: { id: true, orderId: true } });
    if (!found) return null;
    await tx.$queryRaw`SELECT 1 FROM "orders" WHERE id = ${found.orderId} FOR UPDATE`;
    const payment = await tx.orderPayment.findUnique({ where: { id: found.id } });
    const order = await tx.order.findUnique({ where: { id: found.orderId }, select: { id: true, status: true, paymentMethod: true } });
    if (!payment || !order) return null;
    const otherPaid = await tx.orderPayment.count({ where: { orderId: order.id, status: 'paid', id: { not: payment.id } } });
    const decision = decideConfirm(payment, order, otherPaid > 0);
    if (decision === 'already') return null;

    await tx.orderPayment.update({ where: { id: payment.id }, data: { status: 'paid', paidAt: new Date() } });
    if (decision === 'activate') {
      await tx.order.update({ where: { id: order.id }, data: { status: 'PENDING', paymentMethod: ONLINE_PAYMENT_METHOD } });
    } else if (decision === 'mark-paid') {
      await tx.order.update({ where: { id: order.id }, data: { paymentMethod: ONLINE_PAYMENT_METHOD } });
    }
    return { orderId: order.id, event: decision === 'activate' ? ('order:created' as const) : ('order:updated' as const) };
  });
  // 'activate' announces the order to staff for the first time (inbox, toast, beep).
  if (result) await emitOrder(result.orderId, result.event);
}

/**
 * Cancels orders whose online payment window has passed. The window runs from the customer's latest
 * checkout start (or from placing the order, if none was started), so tapping Pay late never cancels an
 * order mid-payment. Read paths call this; there is no timer.
 */
export async function expireStalePaymentOrders(where: Prisma.OrderWhereInput = {}): Promise<void> {
  const cutoff = new Date(Date.now() - PAYMENT_WINDOW_MS);
  await prisma.order.updateMany({
    where: { ...where, status: 'AWAITING_PAYMENT', createdAt: { lt: cutoff }, payments: { none: { createdAt: { gte: cutoff } } } },
    data: { status: 'CANCELLED', rejectionReason: PAYMENT_EXPIRED_REASON },
  });
}

/** "Pay cash instead": the order becomes a normal cash website order and reaches staff now. */
export async function switchToCash(orderId: string): Promise<void> {
  const changed = await prisma.order.updateMany({ where: { id: orderId, status: 'AWAITING_PAYMENT' }, data: { status: 'PENDING' } });
  if (changed.count === 0) throw ApiError.conflict('This order is no longer waiting for payment');
  await emitOrder(orderId, 'order:created');
}

export interface RefundDueRow {
  paymentId: string;
  due: number;
  paid: number;
  reason: RefundReason;
  tracker: string;
  paidAt: Date | null;
  orderId: string;
  orderNumber: string;
  customerName: string | null;
  phone: string | null;
  orderStatus: string;
}

const REFUND_ORDER_SELECT = {
  id: true, orderNumber: true, customerName: true, phone: true, status: true, total: true, paymentMethod: true, outletId: true,
  payments: { select: { id: true, status: true, amount: true, refundedAmount: true, paidAt: true, tracker: true } },
} satisfies Prisma.OrderSelect;

/**
 * Every website payment with money owed back, for the outlet (newest orders first). Almost every online
 * order is paid and owes nothing, so fetching "the newest N paid orders" would push an older order that
 * does owe a refund off the list, and refund due is derived, never stored, so this list is the only place
 * staff see it. A SQL pre-query therefore narrows to the ids of orders that can owe something back
 * (cancelled, paid another way, paid twice, or paid more than the total, with money still unrefunded);
 * it is a superset of what is owed, and `refundsDueForOrder` stays the source of truth for the exact
 * amounts and reasons. Because only those orders are loaded, there is no cap.
 */
export async function listRefundsDue(scope: string | null): Promise<RefundDueRow[]> {
  await expireStalePaymentOrders(scope ? { outletId: scope } : {});
  const scopeClause = scope ? Prisma.sql`AND o."outletId" = ${scope}` : Prisma.empty;
  const candidates = await prisma.$queryRaw<{ id: string }[]>`
    SELECT o.id
    FROM "orders" o
    JOIN "order_payments" p ON p."orderId" = o.id AND p.status = 'paid'
    WHERE o."orderSource" = 'website' ${scopeClause}
    GROUP BY o.id
    HAVING SUM(p.amount - p."refundedAmount") > 0
       AND (o.status = 'cancelled'
            OR o."paymentMethod" IS DISTINCT FROM ${ONLINE_PAYMENT_METHOD}
            OR COUNT(*) > 1
            OR SUM(p.amount - p."refundedAmount") > o.total)
  `;
  if (candidates.length === 0) return [];
  const orders = await prisma.order.findMany({
    where: { id: { in: candidates.map((c) => c.id) } },
    select: REFUND_ORDER_SELECT,
    orderBy: { createdAt: 'desc' },
  });
  return orders.flatMap((o) =>
    refundsDueForOrder({ status: o.status, total: Number(o.total), paymentMethod: o.paymentMethod }, o.payments.map(toPaymentLike))
      .map((d) => {
        const p = o.payments.find((x) => x.id === d.paymentId)!;
        return {
          paymentId: d.paymentId,
          due: d.due,
          paid: Number(p.amount),
          reason: d.reason,
          tracker: p.tracker,
          paidAt: p.paidAt,
          orderId: o.id,
          orderNumber: o.orderNumber,
          customerName: o.customerName,
          phone: o.phone,
          orderStatus: o.status.toLowerCase(),
        };
      })
  );
}

/** Staff refunded a payment from the Safepay dashboard: record the amount currently due as refunded. */
export async function markRefunded(
  paymentId: string,
  scope: string | null,
  by: { name?: string | null } | undefined,
  reference: string | null
): Promise<{ paymentId: string; refunded: number }> {
  const payment = await prisma.orderPayment.findUnique({
    where: { id: paymentId },
    include: { order: { select: REFUND_ORDER_SELECT } },
  });
  if (!payment || (scope && payment.order.outletId !== scope)) throw ApiError.notFound('Payment not found');
  const due = refundsDueForOrder(
    { status: payment.order.status, total: Number(payment.order.total), paymentMethod: payment.order.paymentMethod },
    payment.order.payments.map(toPaymentLike)
  ).find((d) => d.paymentId === paymentId)?.due ?? 0;
  if (due <= 0) throw ApiError.badRequest('Nothing is owed back on this payment');

  // Guarded on the amount read above, so a double click can't record the refund twice.
  const updated = await prisma.orderPayment.updateMany({
    where: { id: paymentId, refundedAmount: payment.refundedAmount },
    data: { refundedAmount: { increment: due }, refundedAt: new Date(), refundedByName: by?.name ?? null, ...(reference ? { refundReference: reference } : {}) },
  });
  if (updated.count === 0) throw ApiError.conflict('This refund was just recorded. Refresh to see it.');
  await emitOrder(payment.orderId, 'order:updated');
  return { paymentId, refunded: due };
}
