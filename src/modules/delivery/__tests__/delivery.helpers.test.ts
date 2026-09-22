import { describe, it, expect } from 'vitest';
import {
  getDefaultWeekRange,
  groupDeliveriesByDay,
  rankRiders,
  deriveHistoryPaymentLabel,
} from '../delivery.helpers.js';

describe('getDefaultWeekRange', () => {
  it('computes correct Monday and today based on PKT time (Wednesday)', () => {
    // 2026-09-16 10:00 UTC = 2026-09-16 15:00 PKT (Wednesday)
    const fixedNowMs = new Date('2026-09-16T10:00:00.000Z').getTime();
    const range = getDefaultWeekRange(fixedNowMs);
    expect(range.from).toBe('2026-09-14'); // Monday
    expect(range.to).toBe('2026-09-16'); // Wednesday
  });

  it('handles Sunday correctly as day 0 in JS rolling back to Monday', () => {
    // 2026-09-20 12:00 UTC = 2026-09-20 17:00 PKT (Sunday)
    const fixedNowMs = new Date('2026-09-20T12:00:00.000Z').getTime();
    const range = getDefaultWeekRange(fixedNowMs);
    expect(range.from).toBe('2026-09-14'); // Previous Monday
    expect(range.to).toBe('2026-09-20'); // Sunday
  });

  it('shifts date correctly when UTC is late night previous day (19:00 UTC = 00:00 PKT next day)', () => {
    // 2026-09-20 20:00 UTC = 2026-09-21 01:00 PKT (Monday morning)
    const fixedNowMs = new Date('2026-09-20T20:00:00.000Z').getTime();
    const range = getDefaultWeekRange(fixedNowMs);
    expect(range.from).toBe('2026-09-21'); // Monday
    expect(range.to).toBe('2026-09-21'); // Monday
  });
});

describe('groupDeliveriesByDay', () => {
  it('zero-fills days when assignments array is empty', () => {
    const result = groupDeliveriesByDay([], '2026-09-14', '2026-09-16');
    expect(result.totalOrders).toBe(0);
    expect(result.totalSales).toBe(0);
    expect(result.totalCommissions).toBe(0);
    expect(result.breakdown).toEqual([
      { date: '2026-09-14', orders: 0, sales: 0, commissions: 0 },
      { date: '2026-09-15', orders: 0, sales: 0, commissions: 0 },
      { date: '2026-09-16', orders: 0, sales: 0, commissions: 0 },
    ]);
  });

  it('aggregates orders, sales, and commissions by PKT calendar day', () => {
    const assignments = [
      {
        deliveredAt: new Date('2026-09-14T08:00:00.000Z'), // 13:00 PKT on 2026-09-14
        commissionEarned: 150,
        order: { total: 1200 },
      },
      {
        deliveredAt: new Date('2026-09-14T12:00:00.000Z'), // 17:00 PKT on 2026-09-14
        commissionEarned: 150,
        order: { total: 800 },
      },
      {
        // 2026-09-15 20:00 UTC = 2026-09-16 01:00 PKT (lands on the 16th!)
        deliveredAt: new Date('2026-09-15T20:00:00.000Z'),
        commissionEarned: 200,
        order: { total: 1500 },
      },
    ];

    const result = groupDeliveriesByDay(assignments, '2026-09-14', '2026-09-16');
    expect(result.totalOrders).toBe(3);
    expect(result.totalSales).toBe(3500);
    expect(result.totalCommissions).toBe(500);

    expect(result.breakdown).toEqual([
      { date: '2026-09-14', orders: 2, sales: 2000, commissions: 300 },
      { date: '2026-09-15', orders: 0, sales: 0, commissions: 0 },
      { date: '2026-09-16', orders: 1, sales: 1500, commissions: 200 },
    ]);
  });
});

describe('rankRiders', () => {
  const rows = [
    { riderId: 'r1', name: 'Zain', deliveries: 8, commissionEarned: 1200 },
    { riderId: 'r2', name: 'Bilal', deliveries: 12, commissionEarned: 1800 },
    { riderId: 'r3', name: 'Ahmed', deliveries: 8, commissionEarned: 1200 },
    { riderId: 'r4', name: 'Hamza', deliveries: 5, commissionEarned: 750 },
  ];

  it('sorts by deliveries desc then name asc with competition ranking for ties', () => {
    const result = rankRiders(rows, 'r1', false);
    expect(result.map(r => ({ name: r.name, deliveries: r.deliveries, rank: r.rank }))).toEqual([
      { name: 'Bilal', deliveries: 12, rank: 1 },
      { name: 'Ahmed', deliveries: 8, rank: 2 }, // ties with Zain, sorted by name asc
      { name: 'Zain', deliveries: 8, rank: 2 },
      { name: 'Hamza', deliveries: 5, rank: 4 }, // 1224 competition ranking (skips 3)
    ]);
  });

  it('exposes commissionEarned only on own row for rider caller', () => {
    const result = rankRiders(rows, 'r1', false);
    const zain = result.find(r => r.riderId === 'r1')!;
    const bilal = result.find(r => r.riderId === 'r2')!;

    expect(zain.isMe).toBe(true);
    expect(zain.commissionEarned).toBe(1200);

    expect(bilal.isMe).toBe(false);
    expect(bilal.commissionEarned).toBeUndefined();
  });

  it('exposes commissionEarned on all rows for manager caller', () => {
    const result = rankRiders(rows, null, true);
    expect(result.every(r => r.commissionEarned !== undefined)).toBe(true);
    expect(result.find(r => r.riderId === 'r2')!.commissionEarned).toBe(1800);
  });
});

describe('deriveHistoryPaymentLabel', () => {
  it('returns null for returned status regardless of paymentMethod', () => {
    expect(deriveHistoryPaymentLabel('returned', 'Cash')).toBeNull();
    expect(deriveHistoryPaymentLabel('returned', 'COD Balance (Cash): Rs.1000')).toBeNull();
  });

  it('returns null for empty, pending, or unpaid', () => {
    expect(deriveHistoryPaymentLabel('delivered', null)).toBeNull();
    expect(deriveHistoryPaymentLabel('delivered', '')).toBeNull();
    expect(deriveHistoryPaymentLabel('delivered', '   ')).toBeNull();
    expect(deriveHistoryPaymentLabel('delivered', 'Pending')).toBeNull();
    expect(deriveHistoryPaymentLabel('delivered', 'unpaid')).toBeNull();
  });

  it('extracts rider-collected method from COD Balance string', () => {
    expect(deriveHistoryPaymentLabel('delivered', 'COD Balance (Cash): Rs.1500')).toBe('Cash');
    expect(
      deriveHistoryPaymentLabel('delivered', 'Advance (Cash: Rs.500), COD Balance (JazzCash): Rs.1000')
    ).toBe('JazzCash');
  });

  it('extracts cashier advance method when no COD Balance exists', () => {
    expect(deriveHistoryPaymentLabel('delivered', 'Advance (JazzCash): Rs.1200')).toBe('JazzCash');
  });

  it('formats multi-split payment strings with +', () => {
    expect(deriveHistoryPaymentLabel('delivered', 'Cash: Rs.900, JazzCash: Rs.779')).toBe(
      'Cash + JazzCash'
    );
  });

  it('returns plain method unchanged', () => {
    expect(deriveHistoryPaymentLabel('delivered', 'Card')).toBe('Card');
    expect(deriveHistoryPaymentLabel('delivered', 'Credit Card')).toBe('Credit Card');
    expect(deriveHistoryPaymentLabel('delivered', 'EasyPaisa')).toBe('EasyPaisa');
  });
});

describe('nonZeroMethods', () => {
  it('filters out zero and negative method entries', async () => {
    const { nonZeroMethods } = await import('../../cash-settlement/cash-settlement.service.js');
    const input = { Cash: 1500, Card: 0, JazzCash: 500, EasyPaisa: 0 };
    expect(nonZeroMethods(input)).toEqual({ Cash: 1500, JazzCash: 500 });
  });
});
