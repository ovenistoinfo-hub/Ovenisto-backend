import { describe, it, expect } from 'vitest';
import { classifyOrderCash, parseNetParts } from '../cash-settlement.service.js';

const base = { total: 1508, advancePayment: 0, riderId: null as string | null, type: 'TAKE_AWAY', reservationId: null as string | null };
const order = (paymentMethod: string | null, extra: Partial<typeof base> = {}) => ({ ...base, paymentMethod, ...extra });

describe('parseNetParts', () => {
  it('reads every "Net (method): Rs.X" part and nothing else', () => {
    expect(parseNetParts('Advance (Cash): Rs.500, Net (Cash): Rs.700, Net (JazzCash): Rs.308'))
      .toEqual([{ method: 'Cash', amount: 700 }, { method: 'JazzCash', amount: 308 }]);
    expect(parseNetParts('Advance (JazzCash): Rs.507')).toEqual([]);
    expect(parseNetParts(null)).toEqual([]);
  });
});

describe('classifyOrderCash — unchanged cases', () => {
  it('credits a plain sale to the cashier', () => {
    expect(classifyOrderCash(order('Cash'))).toEqual({ cashierAmount: 1508, cashierPm: 'Cash', riderAmount: 0, riderPm: '' });
  });

  it('skips an order nobody has been paid for yet', () => {
    expect(classifyOrderCash(order('Pending'))).toBeNull();
    expect(classifyOrderCash(order('Cash on Delivery', { riderId: 'r1', type: 'DELIVERY' }))).toBeNull();
  });

  it('credits a delivered COD order to the rider', () => {
    expect(classifyOrderCash(order('COD Balance (Cash): Rs.1508', { riderId: 'r1', type: 'DELIVERY' })))
      .toEqual({ cashierAmount: 0, cashierPm: '', riderAmount: 1508, riderPm: 'Cash' });
  });

  it('credits a delivery advance taken at the counter to the cashier', () => {
    expect(classifyOrderCash(order('Advance (JazzCash): Rs.507', { advancePayment: 507, type: 'DELIVERY' })))
      .toEqual({ cashierAmount: 507, cashierPm: 'JazzCash', riderAmount: 0, riderPm: '' });
    expect(classifyOrderCash(order('Advance (JazzCash: Rs.507), COD Balance (Cash): Rs.1001', { advancePayment: 507, riderId: 'r1', type: 'DELIVERY' })))
      .toEqual({ cashierAmount: 507, cashierPm: 'JazzCash', riderAmount: 1001, riderPm: 'Cash' });
  });

  it('skips an order paid online: the money is in the bank, not a drawer', () => {
    expect(classifyOrderCash(order('Online (Safepay)'))).toBeNull();
    expect(classifyOrderCash(order('Online (Safepay)', { type: 'DELIVERY', riderId: 'r1' }))).toBeNull();
  });
});

describe('classifyOrderCash — advance paid earlier, rest at the counter', () => {
  const pm = 'Advance (Cash): Rs.500, Net (JazzCash): Rs.1008';

  it('credits the whole bill when the advance is not tracked on a booking (it used to drop the net part)', () => {
    expect(classifyOrderCash(order(pm, { advancePayment: 500 }))).toEqual({ cashierAmount: 1508, cashierPm: pm, riderAmount: 0, riderPm: '' });
  });

  it('credits only the net part when the booking tracks the advance', () => {
    expect(classifyOrderCash(order(pm, { advancePayment: 500, reservationId: 'res-1' })))
      .toEqual({ cashierAmount: 1008, cashierPm: 'JazzCash', riderAmount: 0, riderPm: '' });
    expect(classifyOrderCash(order('Advance (Cash): Rs.500, Net (Cash): Rs.700, Net (JazzCash): Rs.308', { advancePayment: 500, reservationId: 'res-1' })))
      .toEqual({ cashierAmount: 1008, cashierPm: 'Cash: Rs.700, JazzCash: Rs.308', riderAmount: 0, riderPm: '' });
  });
});

describe('classifyOrderCash — tracked booking advance on other strings', () => {
  it('credits a Waiter Panel order total − advance', () => {
    expect(classifyOrderCash(order('Cash', { total: 1000, advancePayment: 500, reservationId: 'res-1', type: 'DINE_IN' })))
      .toEqual({ cashierAmount: 500, cashierPm: 'Cash', riderAmount: 0, riderPm: '' });
  });

  it('credits nothing when the advance covered the whole order', () => {
    expect(classifyOrderCash(order('Cash', { advancePayment: 1508, reservationId: 'res-1' }))).toBeNull();
  });

  it('leaves the rider their COD and gives the cashier nothing for the advance', () => {
    expect(classifyOrderCash(order('Advance (Cash: Rs.500), COD Balance (Cash): Rs.1008', { advancePayment: 500, reservationId: 'res-1', riderId: 'r1', type: 'DELIVERY' })))
      .toEqual({ cashierAmount: 0, cashierPm: 'Cash', riderAmount: 1008, riderPm: 'Cash' });
  });

  it('still skips an unpaid order', () => {
    expect(classifyOrderCash(order('Pending', { advancePayment: 500, reservationId: 'res-1' }))).toBeNull();
  });
});
