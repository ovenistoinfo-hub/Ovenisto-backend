import { describe, it, expect } from 'vitest';
import {
  ONLINE_PAYMENT_METHOD, isOnlinePaid, decideConfirm, refundsDueForOrder,
  toPaymentView, toPaymentLike, resolveReturnOrigin, webhookTracker, onlinePaidEditBlock, PAID_ONLINE_EDIT_MESSAGE,
  type PaymentLike,
} from '../payment.rules.js';

const pay = (id: string, extra: Partial<PaymentLike> = {}): PaymentLike => ({
  id, status: 'paid', amount: 1500, refundedAmount: 0, paidAt: new Date('2026-10-12T10:00:00Z'), ...extra,
});
const paidOrder = { status: 'PENDING', total: 1500, paymentMethod: ONLINE_PAYMENT_METHOD };

describe('isOnlinePaid', () => {
  it('matches only the exact gateway method', () => {
    expect(isOnlinePaid('Online (Safepay)')).toBe(true);
    expect(isOnlinePaid(' Online (Safepay) ')).toBe(true);
    expect(isOnlinePaid('Cash')).toBe(false);
    expect(isOnlinePaid(null)).toBe(false);
  });
});

describe('decideConfirm', () => {
  it('does nothing for a payment already paid', () => {
    expect(decideConfirm({ status: 'paid' }, { status: 'AWAITING_PAYMENT', paymentMethod: 'Pending' }, false)).toBe('already');
  });
  it('activates an order waiting for payment', () => {
    expect(decideConfirm({ status: 'initiated' }, { status: 'AWAITING_PAYMENT', paymentMethod: 'Pending' }, false)).toBe('activate');
  });
  it('marks a switched-to-cash order paid while it is still unpaid', () => {
    expect(decideConfirm({ status: 'initiated' }, { status: 'PENDING', paymentMethod: 'Pending' }, false)).toBe('mark-paid');
  });
  it('only records the payment (for a refund) when the order is cancelled, paid another way, or paid twice', () => {
    expect(decideConfirm({ status: 'initiated' }, { status: 'CANCELLED', paymentMethod: 'Pending' }, false)).toBe('refund-only');
    expect(decideConfirm({ status: 'initiated' }, { status: 'COMPLETED', paymentMethod: 'Cash' }, false)).toBe('refund-only');
    expect(decideConfirm({ status: 'initiated' }, { status: 'AWAITING_PAYMENT', paymentMethod: 'Pending' }, true)).toBe('refund-only');
  });
});

describe('refundsDueForOrder', () => {
  it('owes nothing on a normal paid order', () => {
    expect(refundsDueForOrder(paidOrder, [pay('p1')])).toEqual([]);
  });
  it('owes the full amount when the order is cancelled', () => {
    expect(refundsDueForOrder({ ...paidOrder, status: 'CANCELLED' }, [pay('p1')]))
      .toEqual([{ paymentId: 'p1', due: 1500, reason: 'cancelled' }]);
  });
  it('owes the difference when items were removed after paying', () => {
    expect(refundsDueForOrder({ ...paidOrder, total: 1100 }, [pay('p1')]))
      .toEqual([{ paymentId: 'p1', due: 400, reason: 'over_total' }]);
  });
  it('owes a second payment in full (paid twice), keeping the first', () => {
    const second = pay('p2', { paidAt: new Date('2026-10-12T10:05:00Z') });
    expect(refundsDueForOrder(paidOrder, [second, pay('p1')]))
      .toEqual([{ paymentId: 'p2', due: 1500, reason: 'duplicate' }]);
  });
  it('owes everything when the order was paid another way', () => {
    expect(refundsDueForOrder({ ...paidOrder, paymentMethod: 'Cash' }, [pay('p1')]))
      .toEqual([{ paymentId: 'p1', due: 1500, reason: 'paid_other_way' }]);
  });
  it('takes off what was already refunded, and ignores unpaid attempts', () => {
    expect(refundsDueForOrder({ ...paidOrder, status: 'CANCELLED' }, [pay('p1', { refundedAmount: 1500 }), pay('p0', { status: 'initiated' })])).toEqual([]);
    expect(refundsDueForOrder({ ...paidOrder, status: 'CANCELLED' }, [pay('p1', { refundedAmount: 1000 })]))
      .toEqual([{ paymentId: 'p1', due: 500, reason: 'cancelled' }]);
  });
});

describe('toPaymentView', () => {
  it('is null for a cash order', () => {
    expect(toPaymentView({ status: 'PENDING', total: 900, paymentMethod: 'Pending' }, [])).toBeNull();
  });
  it('is awaiting while the order waits for payment', () => {
    expect(toPaymentView({ status: 'AWAITING_PAYMENT', total: 900, paymentMethod: 'Pending' }, [pay('p1', { status: 'initiated', amount: 900 })]))
      .toEqual({ status: 'awaiting', amount: 900, refundDue: 0 });
  });
  it('is paid, then refund_pending, then refunded', () => {
    expect(toPaymentView(paidOrder, [pay('p1')])).toEqual({ status: 'paid', amount: 1500, refundDue: 0 });
    expect(toPaymentView({ ...paidOrder, status: 'CANCELLED' }, [pay('p1')])).toEqual({ status: 'refund_pending', amount: 1500, refundDue: 1500 });
    expect(toPaymentView({ ...paidOrder, status: 'CANCELLED' }, [pay('p1', { refundedAmount: 1500 })])).toEqual({ status: 'refunded', amount: 1500, refundDue: 0 });
  });
});

describe('toPaymentLike', () => {
  it('turns Decimal-like amounts into numbers', () => {
    const row = { id: 'p1', status: 'paid', amount: { valueOf: () => 1500 }, refundedAmount: '0', paidAt: null };
    expect(toPaymentLike(row)).toEqual({ id: 'p1', status: 'paid', amount: 1500, refundedAmount: 0, paidAt: null });
  });
});

describe('resolveReturnOrigin', () => {
  const allowed = ['https://ovenisto-frontend-website.vercel.app', 'https://website-stagging.up.railway.app'];
  it('accepts an allowed origin, a vercel preview and localhost', () => {
    expect(resolveReturnOrigin('https://website-stagging.up.railway.app', allowed)).toBe('https://website-stagging.up.railway.app');
    expect(resolveReturnOrigin('https://preview-123.vercel.app', allowed)).toBe('https://preview-123.vercel.app');
    expect(resolveReturnOrigin('http://localhost:8081', allowed)).toBe('http://localhost:8081');
  });
  it('rejects anything else', () => {
    expect(resolveReturnOrigin('https://evil.example.com', allowed)).toBeNull();
    expect(resolveReturnOrigin('https://localhost.evil.com', allowed)).toBeNull();
    expect(resolveReturnOrigin('null', allowed)).toBeNull();
    expect(resolveReturnOrigin(undefined, allowed)).toBeNull();
  });
});

describe('webhookTracker', () => {
  it('returns the tracker of a paid event', () => {
    expect(webhookTracker({ type: 'payment:created', data: { tracker: 'track_1' } })).toBe('track_1');
    expect(webhookTracker({ data: { tracker: 'track_2', state: 'PAID' } })).toBe('track_2');
    expect(webhookTracker({ data: { notification: { tracker: 'track_3', state: 'TRACKER_ENDED' } } })).toBe('track_3');
  });
  it('ignores other events and malformed bodies', () => {
    expect(webhookTracker({ type: 'payment:failed', data: { tracker: 'track_1', state: 'FAILED' } })).toBeNull();
    expect(webhookTracker({ type: 'payment:created', data: {} })).toBeNull();
    expect(webhookTracker(null)).toBeNull();
  });
  it('refuses an event whose type says it failed, even when the state looks paid', () => {
    expect(webhookTracker({ type: 'payment:failed', data: { tracker: 't', state: 'TRACKER_ENDED' } })).toBeNull();
    expect(webhookTracker({ type: 'payment:cancelled', data: { tracker: 't', state: 'PAID' } })).toBeNull();
    expect(webhookTracker({ data: { type: 'payment.refunded', tracker: 't', state: 'PAID' } })).toBeNull();
  });
});

describe('onlinePaidEditBlock', () => {
  it('allows edits that keep the method and stay within what was paid', () => {
    expect(onlinePaidEditBlock({ paidAmount: 1500 })).toBeNull();
    expect(onlinePaidEditBlock({ newTotal: 1200, paidAmount: 1500 })).toBeNull();
    expect(onlinePaidEditBlock({ newPaymentMethod: ONLINE_PAYMENT_METHOD, newTotal: 1500, paidAmount: 1500 })).toBeNull();
  });
  it('refuses a different method or a higher total', () => {
    expect(onlinePaidEditBlock({ newPaymentMethod: 'Cash', paidAmount: 1500 })).toBe(PAID_ONLINE_EDIT_MESSAGE);
    expect(onlinePaidEditBlock({ newTotal: 1800, paidAmount: 1500 })).toBe(PAID_ONLINE_EDIT_MESSAGE);
  });
});
