import { describe, it, expect } from 'vitest';
import { parseDateRange, buildOrderWhere, computeCogs, displayOrderType } from '../reports.helpers.js';

describe('parseDateRange', () => {
  it('parses valid from/to into inclusive day boundaries', () => {
    const { gte, lte } = parseDateRange('2026-06-01', '2026-06-07');
    expect(gte.toISOString()).toBe('2026-06-01T00:00:00.000Z');
    expect(lte.toISOString()).toBe('2026-06-07T23:59:59.999Z');
  });

  it('throws on missing from', () => {
    expect(() => parseDateRange(undefined, '2026-06-07')).toThrow();
  });

  it('throws on invalid date', () => {
    expect(() => parseDateRange('not-a-date', '2026-06-07')).toThrow();
  });
});

describe('buildOrderWhere', () => {
  const gte = new Date('2026-06-01T00:00:00.000Z');
  const lte = new Date('2026-06-07T23:59:59.999Z');

  it('omits outletId when outlet is "all"', () => {
    const where = buildOrderWhere(gte, lte, 'all');
    expect(where).toEqual({ createdAt: { gte, lte } });
  });

  it('adds outletId when a specific outlet is given', () => {
    const where = buildOrderWhere(gte, lte, 'outlet-123');
    expect(where).toEqual({ createdAt: { gte, lte }, outletId: 'outlet-123' });
  });

  it('treats undefined outlet as all', () => {
    const where = buildOrderWhere(gte, lte, undefined);
    expect(where).toEqual({ createdAt: { gte, lte } });
  });
});

describe('computeCogs', () => {
  it('sums recipe qty * item qty * purchasePrice for matching recipes', () => {
    const items = [
      { menuItemId: 'm1', variantId: null, qty: 2 },
      { menuItemId: 'm2', variantId: 'v1', qty: 1 },
    ];
    const recipes = [
      { menuItemId: 'm1', variantId: null, ingredientId: 'i1', qtyPerUnit: 3 },
      { menuItemId: 'm2', variantId: 'v1', ingredientId: 'i1', qtyPerUnit: 5 },
      { menuItemId: 'm2', variantId: 'v2', ingredientId: 'i1', qtyPerUnit: 99 }, // wrong variant, ignored
    ];
    const priceById = new Map([['i1', 10]]);
    // m1: 3 * 2 * 10 = 60 ; m2/v1: 5 * 1 * 10 = 50 ; total = 110
    expect(computeCogs(items, recipes, priceById)).toBe(110);
  });

  it('contributes 0 for items with no matching recipe', () => {
    const items = [{ menuItemId: 'mX', variantId: null, qty: 5 }];
    expect(computeCogs(items, [], new Map())).toBe(0);
  });

  it('treats missing purchasePrice as 0', () => {
    const items = [{ menuItemId: 'm1', variantId: null, qty: 2 }];
    const recipes = [{ menuItemId: 'm1', variantId: null, ingredientId: 'i1', qtyPerUnit: 3 }];
    expect(computeCogs(items, recipes, new Map())).toBe(0);
  });
});

import {
  monthBoundaries, dayBoundaries, classifyChannel, growthPct, fillChannels, groupPayments, normalizePaymentMethod,
  CHANNEL_ORDER,
} from '../reports.helpers.js';

describe('monthBoundaries', () => {
  it('returns this-month and last-month UTC ranges', () => {
    const b = monthBoundaries(new Date('2026-06-19T10:00:00.000Z'));
    expect(b.thisStart.toISOString()).toBe('2026-06-01T00:00:00.000Z');
    expect(b.thisEnd.toISOString()).toBe('2026-06-30T23:59:59.999Z');
    expect(b.lastStart.toISOString()).toBe('2026-05-01T00:00:00.000Z');
    expect(b.lastEnd.toISOString()).toBe('2026-05-31T23:59:59.999Z');
  });
  it('handles January (last month = previous December)', () => {
    const b = monthBoundaries(new Date('2026-01-15T10:00:00.000Z'));
    expect(b.lastStart.toISOString()).toBe('2025-12-01T00:00:00.000Z');
    expect(b.lastEnd.toISOString()).toBe('2025-12-31T23:59:59.999Z');
  });
});

describe('dayBoundaries', () => {
  it('returns the UTC start and end of the given day', () => {
    const d = dayBoundaries(new Date('2026-06-19T14:30:00.000Z'));
    expect(d.gte.toISOString()).toBe('2026-06-19T00:00:00.000Z');
    expect(d.lte.toISOString()).toBe('2026-06-19T23:59:59.999Z');
  });
});

describe('classifyChannel', () => {
  it('classifies online types', () => {
    expect(classifyChannel('Foodpanda')).toBe('online');
    expect(classifyChannel('Online')).toBe('online');
    expect(classifyChannel('Self Order')).toBe('online');
  });
  it('classifies offline types (incl. unknown -> offline)', () => {
    expect(classifyChannel('Dine In')).toBe('offline');
    expect(classifyChannel('Take Away')).toBe('offline');
    expect(classifyChannel('Walk-in')).toBe('offline');
    expect(classifyChannel('Whatever')).toBe('offline');
  });
  it('online types still classify when passed through displayOrderType', () => {
    expect(classifyChannel(displayOrderType('FOODPANDA'))).toBe('online');
    expect(classifyChannel(displayOrderType('SELF_ORDER'))).toBe('online');
    expect(classifyChannel(displayOrderType('DINE_IN'))).toBe('offline');
  });
});

describe('growthPct', () => {
  it('computes percentage change', () => {
    expect(growthPct(120, 100)).toBe(20);
    expect(growthPct(80, 100)).toBe(-20);
  });
  it('returns 0 when previous is 0 (no divide-by-zero)', () => {
    expect(growthPct(500, 0)).toBe(0);
    expect(growthPct(0, 0)).toBe(0);
  });
});

describe('fillChannels', () => {
  it('zero-fills every channel in CHANNEL_ORDER and preserves provided values', () => {
    const out = fillChannels([{ type: 'Dine In', sales: 2867, orders: 5 }]);
    expect(out.map(c => c.type)).toEqual(CHANNEL_ORDER);
    expect(out.find(c => c.type === 'Dine In')).toEqual({ type: 'Dine In', sales: 2867, orders: 5 });
    expect(out.find(c => c.type === 'Delivery')).toEqual({ type: 'Delivery', sales: 0, orders: 0 });
  });
});

describe('groupPayments', () => {
  it('sums by method, ignores null methods, sorts desc, rounds', () => {
    const out = groupPayments([
      { method: 'Cash', amount: 100 }, { method: 'Card', amount: 50 },
      { method: 'Cash', amount: 22.4 }, { method: null, amount: 999 },
    ]);
    expect(out).toEqual([{ method: 'Cash', amount: 122 }, { method: 'Card', amount: 50 }]);
  });

  it('normalizes messy POS payment strings to a clean method name', () => {
    // Real POS data stores method+amount in one string, sometimes split payments.
    const out = groupPayments([
      { method: 'Cash: Rs.400', amount: 400 },
      { method: 'Cash: Rs.8700', amount: 8700 },
      { method: 'Advance (Cash): Rs.1500', amount: 1500 },
      { method: 'Cash: Rs.1000, JazzCash: Rs.980', amount: 1980 }, // split -> first method
      { method: 'JazzCash', amount: 500 },
    ]);
    // Cash bucket = 400+8700+1500+1980 = 12580 ; JazzCash = 500
    expect(out).toEqual([
      { method: 'Cash', amount: 12580 },
      { method: 'JazzCash', amount: 500 },
    ]);
  });
});

describe('normalizePaymentMethod', () => {
  it('extracts the method name from messy strings', () => {
    expect(normalizePaymentMethod('Cash: Rs.400')).toBe('Cash');
    expect(normalizePaymentMethod('Advance (Cash): Rs.1500')).toBe('Cash');
    expect(normalizePaymentMethod('Cash: Rs.1000, JazzCash: Rs.980')).toBe('Cash');
    expect(normalizePaymentMethod('JazzCash')).toBe('JazzCash');
    expect(normalizePaymentMethod('  Card  ')).toBe('Card');
  });
  it('returns null for empty/null', () => {
    expect(normalizePaymentMethod(null)).toBe(null);
    expect(normalizePaymentMethod('')).toBe(null);
  });
});

describe('displayOrderType', () => {
  it('maps enum member names to display strings', () => {
    expect(displayOrderType('DINE_IN')).toBe('Dine In');
    expect(displayOrderType('FOODPANDA')).toBe('Foodpanda');
    expect(displayOrderType('SELF_ORDER')).toBe('Self Order');
    expect(displayOrderType('TAKE_AWAY')).toBe('Take Away');
  });
  it('passes through already-display or unknown values', () => {
    expect(displayOrderType('Dine In')).toBe('Dine In');
    expect(displayOrderType('Whatever')).toBe('Whatever');
  });
});
