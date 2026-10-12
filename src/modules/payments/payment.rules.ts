// Website online payment (Safepay): the pure rules. The DB side is payment.service.ts, the gateway
// safepay.ts. "Refund due" is derived here from the payment rows, never stored, so no cancel path
// can forget it.

/** What a paid-online order stores in Order.paymentMethod. Cash Hub skips it: the money is in the bank. */
export const ONLINE_PAYMENT_METHOD = 'Online (Safepay)';

export const isOnlinePaid = (paymentMethod: string | null | undefined) => (paymentMethod ?? '').trim() === ONLINE_PAYMENT_METHOD;

/**
 * An order still waiting for its online payment is cancelled (on the next read) once this long has passed
 * since the customer's latest checkout start, or since the order was placed if none was started.
 */
export const PAYMENT_WINDOW_MS = 30 * 60 * 1000;
export const PAYMENT_EXPIRED_REASON = 'Payment not completed';
export const ONLINE_ORIGIN_MESSAGE = 'Online payment has to be started from the Ovenisto website';
export const PAID_ONLINE_EDIT_MESSAGE =
  "This order was paid online: its payment method can't change and its total can't go above what was paid. Add extra items as a new order.";

const isUnpaidMethod = (pm: string | null | undefined) => {
  const v = (pm ?? '').trim().toLowerCase();
  return v === '' || v === 'pending' || v === 'unpaid';
};

export type ConfirmDecision = 'already' | 'activate' | 'mark-paid' | 'refund-only';

/**
 * What a verified Safepay confirmation does. Except for 'already', the payment becomes paid:
 * 'activate' → the waiting order goes to staff; 'mark-paid' → a switched-to-cash, still unpaid order is
 * now paid online; 'refund-only' → nothing else changes, and the payment shows under Refunds due.
 */
export function decideConfirm(
  payment: { status: string },
  order: { status: string; paymentMethod: string | null },
  anotherPaymentPaid: boolean
): ConfirmDecision {
  if (payment.status === 'paid') return 'already';
  if (anotherPaymentPaid) return 'refund-only';
  if (order.status === 'AWAITING_PAYMENT') return 'activate';
  if (order.status !== 'CANCELLED' && isUnpaidMethod(order.paymentMethod)) return 'mark-paid';
  return 'refund-only';
}

export interface PaymentLike {
  id: string;
  status: string;
  amount: number;
  refundedAmount: number;
  paidAt: Date | null;
}

/** An OrderPayment row (Prisma Decimals) as plain numbers. */
export function toPaymentLike(p: { id: string; status: string; amount: unknown; refundedAmount: unknown; paidAt: Date | null }): PaymentLike {
  return { id: p.id, status: p.status, amount: Number(p.amount), refundedAmount: Number(p.refundedAmount), paidAt: p.paidAt };
}

export type RefundReason = 'cancelled' | 'paid_other_way' | 'over_total' | 'duplicate';

const money = (n: number) => Math.max(0, Math.round(n * 100) / 100);

/**
 * What each paid payment of an order owes back, after what was already refunded (only entries of
 * Rs. 1 or more). Oldest paid payment first: it is kept while the order is live and still marked paid
 * online, owing back only what the order no longer costs; every other paid payment is owed in full.
 */
export function refundsDueForOrder(
  order: { status: string; total: number; paymentMethod: string | null },
  payments: PaymentLike[]
): { paymentId: string; due: number; reason: RefundReason }[] {
  const cancelled = order.status === 'CANCELLED';
  const online = isOnlinePaid(order.paymentMethod);
  return payments
    .filter((p) => p.status === 'paid')
    .sort((a, b) => (a.paidAt?.getTime() ?? 0) - (b.paidAt?.getTime() ?? 0))
    .map((p, i) => {
      const kept = !cancelled && online && i === 0;
      const owed = kept ? Math.max(0, p.amount - order.total) : p.amount;
      const reason: RefundReason = cancelled ? 'cancelled' : !online ? 'paid_other_way' : kept ? 'over_total' : 'duplicate';
      return { paymentId: p.id, due: money(owed - p.refundedAmount), reason };
    })
    .filter((r) => r.due >= 1);
}

export type PaymentView = { status: 'awaiting' | 'paid' | 'refund_pending' | 'refunded'; amount: number; refundDue: number };

/** The customer's view of an order's online payment; null for a cash order. */
export function toPaymentView(
  order: { status: string; total: number; paymentMethod: string | null },
  payments: PaymentLike[]
): PaymentView | null {
  const paid = payments.filter((p) => p.status === 'paid');
  if (paid.length === 0) {
    return order.status === 'AWAITING_PAYMENT' ? { status: 'awaiting', amount: order.total, refundDue: 0 } : null;
  }
  const amount = money(paid.reduce((s, p) => s + p.amount, 0));
  const refundDue = money(refundsDueForOrder(order, payments).reduce((s, r) => s + r.due, 0));
  const refunded = money(paid.reduce((s, p) => s + p.refundedAmount, 0));
  const fullyBack = order.status === 'CANCELLED' || !isOnlinePaid(order.paymentMethod);
  const status: PaymentView['status'] = refundDue > 0 ? 'refund_pending' : refunded > 0 && fullyBack ? 'refunded' : 'paid';
  return { status, amount, refundDue };
}

/** Where Safepay sends the customer back: the request's Origin, when the CORS rule allows it. */
export function resolveReturnOrigin(origin: string | undefined, allowedOrigins: string[]): string | null {
  if (!origin) return null;
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  const ok = allowedOrigins.includes(url.origin)
    || url.hostname.endsWith('.vercel.app')
    || url.hostname === 'localhost'
    || url.hostname === '127.0.0.1';
  return ok ? url.origin : null;
}

/**
 * The tracker of a Safepay webhook that reports a completed payment, else null. The payload shape is
 * to be confirmed against a real sandbox webhook (see the spec); keep this function and its test in step.
 */
export function webhookTracker(body: unknown): string | null {
  if (!body || typeof body !== 'object') return null;
  const b = body as Record<string, any>;
  const data = b.data && typeof b.data === 'object' ? b.data : {};
  const tracker = data.tracker ?? data.notification?.tracker ?? data.token;
  const type = String(b.type ?? data.type ?? '').toLowerCase();
  const state = String(data.state ?? data.notification?.state ?? '').toUpperCase();
  const paid = type === 'payment:created' || type === 'payment.succeeded' || state === 'PAID' || state === 'TRACKER_ENDED';
  return typeof tracker === 'string' && tracker.length > 0 && paid ? tracker : null;
}

/** For an order already paid online: why an edit must be refused, or null. */
export function onlinePaidEditBlock(p: { newPaymentMethod?: string | null; newTotal?: number; paidAmount: number }): string | null {
  if (p.newPaymentMethod !== undefined && !isOnlinePaid(p.newPaymentMethod)) return PAID_ONLINE_EDIT_MESSAGE;
  if (p.newTotal !== undefined && p.newTotal > p.paidAmount + 0.5) return PAID_ONLINE_EDIT_MESSAGE;
  return null;
}
