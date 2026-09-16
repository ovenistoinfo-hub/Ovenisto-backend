import { describe, it, expect } from 'vitest';
import { parseDateRange, buildOrderWhere, computeCogs, displayOrderType, isLowStock, parseTimeOfDay, isWithinTimeOfDay, splitOrderTotalByLine } from '../reports.helpers.js';

describe('parseDateRange', () => {
  it('parses valid from/to into inclusive PKT day boundaries (UTC-5h from the raw date strings)', () => {
    const { gte, lte } = parseDateRange('2026-06-01', '2026-06-07');
    expect(gte.toISOString()).toBe('2026-05-31T19:00:00.000Z');
    expect(lte.toISOString()).toBe('2026-06-07T18:59:59.999Z');
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

  it('falls back to the item-level recipe when the order line has a variantId but no variant-specific recipe exists', () => {
    // Menu item whose recipe was only ever defined once, at the item level -- a real order line
    // for a specific size (variantId set) must still cost against it, not silently cost 0.
    const items = [{ menuItemId: 'm1', variantId: 'medium', qty: 1 }];
    const recipes = [{ menuItemId: 'm1', variantId: null, ingredientId: 'i1', qtyPerUnit: 3 }];
    const priceById = new Map([['i1', 10]]);
    expect(computeCogs(items, recipes, priceById)).toBe(30);
  });

  it('includes both the item-level recipe AND the variant-specific recipe when both exist', () => {
    const items = [{ menuItemId: 'm1', variantId: 'large', qty: 1 }];
    const recipes = [
      { menuItemId: 'm1', variantId: null, ingredientId: 'i1', qtyPerUnit: 2 },   // shared base
      { menuItemId: 'm1', variantId: 'large', ingredientId: 'i2', qtyPerUnit: 1 }, // large-only extra
      { menuItemId: 'm1', variantId: 'small', ingredientId: 'i2', qtyPerUnit: 99 }, // wrong variant, ignored
    ];
    const priceById = new Map([['i1', 10], ['i2', 20]]);
    // base: 2 * 1 * 10 = 20 ; large extra: 1 * 1 * 20 = 20 ; total = 40
    expect(computeCogs(items, recipes, priceById)).toBe(40);
  });

  it('returns the raw fractional total, NOT internally rounded', () => {
    // Regression for the 2026-09-16 fix: computeCogs used to Math.round() its own return value,
    // so two report endpoints that sum several calls at different groupings (once per order vs
    // once per channel/category/staff bucket) rounded at different points and drifted apart by a
    // few rupees on the same underlying orders. Callers now accumulate the raw total across calls
    // and round exactly once at their own final output.
    const items = [{ menuItemId: 'm1', variantId: null, qty: 1 }];
    const recipes = [{ menuItemId: 'm1', variantId: null, ingredientId: 'i1', qtyPerUnit: 1 }];
    const priceById = new Map([['i1', 10.4]]);
    expect(computeCogs(items, recipes, priceById)).toBeCloseTo(10.4);
  });
});

describe('splitOrderTotalByLine', () => {
  it('splits proportionally to line gross and sums back to the total', () => {
    expect(splitOrderTotalByLine(1000, [600, 400])).toEqual([600, 400]);
  });

  it('bakes tax/order-discount into the split by prorating the FINAL total, not the gross', () => {
    // order total 1100 (e.g. +10% tax) over line grosses summing to 1000
    const parts = splitOrderTotalByLine(1100, [600, 400]);
    expect(parts).toEqual([660, 440]);
    expect(parts.reduce((s, v) => s + v, 0)).toBe(1100);
  });

  it('absorbs rounding drift on the last positive-weight line so parts sum exactly', () => {
    const parts = splitOrderTotalByLine(1000, [1, 1, 1]);
    expect(parts.reduce((s, v) => s + v, 0)).toBe(1000);
    expect(parts).toEqual([333, 333, 334]);
  });

  it('returns [total] for a single line and [] for no lines', () => {
    expect(splitOrderTotalByLine(950, [800])).toEqual([950]);
    expect(splitOrderTotalByLine(500, [])).toEqual([]);
  });

  it('falls back to an equal split when every line gross is <= 0 (comped order)', () => {
    expect(splitOrderTotalByLine(300, [0, 0, 0])).toEqual([100, 100, 100]);
  });

  it('clamps an over-discounted (negative-gross) line to zero weight', () => {
    const parts = splitOrderTotalByLine(1000, [1000, -50]);
    expect(parts).toEqual([1000, 0]);
    expect(parts.reduce((s, v) => s + v, 0)).toBe(1000);
  });
});

import {
  monthBoundaries, dayBoundaries, classifyChannel, growthPct, fillChannels, groupPayments,
  groupPaymentsWithCounts, orderUsedPaymentMethod,
  CHANNEL_ORDER,
} from '../reports.helpers.js';

describe('groupPaymentsWithCounts', () => {
  it('counts orders per method, a split crediting (and counting) both of its methods', () => {
    const out = groupPaymentsWithCounts([
      { method: 'Cash', amount: 400 },
      { method: 'Cash: Rs.1000, JazzCash: Rs.980', amount: 1980 }, // split -> both
      { method: 'JazzCash', amount: 500 },
    ]);
    // Cash = 400 + 1000 = 1400 over 2 orders ; JazzCash = 980 + 500 = 1480 over 2 orders
    expect(out).toEqual([
      { method: 'JazzCash', amount: 1480, orders: 2 },
      { method: 'Cash', amount: 1400, orders: 2 },
    ]);
  });

  it('defaults a null method to Cash and still counts it; ignores zero-amount rows', () => {
    expect(groupPaymentsWithCounts([
      { method: null, amount: 500 },
      { method: 'Cash', amount: 100 },
      { method: 'Cash', amount: 0 },
    ])).toEqual([{ method: 'Cash', amount: 600, orders: 2 }]);
  });

  it('groupPayments is the same figures without the count', () => {
    const rows = [{ method: 'Cash', amount: 100 }, { method: 'JazzCash', amount: 250 }];
    expect(groupPayments(rows)).toEqual([
      { method: 'JazzCash', amount: 250 },
      { method: 'Cash', amount: 100 },
    ]);
  });
});

describe('orderUsedPaymentMethod', () => {
  it('matches a bare single-method string', () => {
    expect(orderUsedPaymentMethod('Cash', 900, 'Cash')).toBe(true);
    expect(orderUsedPaymentMethod('JazzCash', 900, 'JazzCash')).toBe(true);
  });

  it('does NOT match "Cash" against a "JazzCash" order (no substring trap)', () => {
    expect(orderUsedPaymentMethod('JazzCash', 900, 'Cash')).toBe(false);
  });

  it('matches every method of a genuine split', () => {
    const s = 'Cash: Rs.900, JazzCash: Rs.779';
    expect(orderUsedPaymentMethod(s, 1679, 'Cash')).toBe(true);
    expect(orderUsedPaymentMethod(s, 1679, 'JazzCash')).toBe(true);
    expect(orderUsedPaymentMethod(s, 1679, 'EasyPaisa')).toBe(false);
  });

  it('is case-insensitive on the wanted name, and false for a null/blank string', () => {
    expect(orderUsedPaymentMethod('JazzCash', 900, 'jazzcash')).toBe(true);
    expect(orderUsedPaymentMethod(null, 900, 'Cash')).toBe(false);
    expect(orderUsedPaymentMethod('   ', 900, 'Cash')).toBe(false);
  });
});

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
  it('sums by exact-match method name, canonicalizes an alias ("Card" -> "Credit Card"), defaults a null method to Cash, sorts desc, rounds', () => {
    const out = groupPayments([
      { method: 'Cash', amount: 100 }, { method: 'Card', amount: 50 },
      { method: 'Cash', amount: 22.4 }, { method: null, amount: 999 },
    ]);
    // Cash = 100 + 22.4 + 999 (null defaults to Cash) = 1121.4 -> rounds to 1121
    // 'Card' canonicalizes to the configured 'Credit Card' bucket via alias matching.
    expect(out).toEqual([{ method: 'Cash', amount: 1121 }, { method: 'Credit Card', amount: 50 }]);
  });

  it('splits a genuine multi-method payment across ALL its methods with their own amounts, not just the first segment', () => {
    // Real POS data stores method+amount in one string, sometimes split payments.
    const out = groupPayments([
      { method: 'Cash: Rs.400', amount: 400 },
      { method: 'Cash: Rs.8700', amount: 8700 },
      { method: 'Advance (Cash): Rs.1500', amount: 1500 },
      { method: 'Cash: Rs.1000, JazzCash: Rs.980', amount: 1980 }, // split -> BOTH methods credited
      { method: 'JazzCash', amount: 500 },
    ]);
    // Cash = 400+8700+1500+1000 = 11600 ; JazzCash = 980+500 = 1480 (no dropped JazzCash portion)
    // Total 11600+1480=13080 matches the sum of the raw amounts (400+8700+1500+1980+500=13080).
    expect(out).toEqual([
      { method: 'Cash', amount: 11600 },
      { method: 'JazzCash', amount: 1480 },
    ]);
  });

  it('extracts clean method labels from a delivered-COD order\'s Advance(...)/COD Balance(...) string, not a truncated "Advance (JazzCash" label', () => {
    const out = groupPayments([
      { method: 'Advance (JazzCash: Rs.507), COD Balance (Cash): Rs.1000', amount: 1507 },
    ]);
    expect(out).toEqual([
      { method: 'Cash', amount: 1000 },
      { method: 'JazzCash', amount: 507 },
    ]);
  });
});

describe('isLowStock', () => {
  it('is true when stock is below the threshold', () => {
    expect(isLowStock(5, 10)).toBe(true);
  });
  it('is true when stock exactly equals the threshold', () => {
    expect(isLowStock(10, 10)).toBe(true);
  });
  it('is false when stock is above the threshold', () => {
    expect(isLowStock(15, 10)).toBe(false);
  });
  it('is true at a zero threshold only when stock is also zero or negative', () => {
    expect(isLowStock(0, 0)).toBe(true);
    expect(isLowStock(1, 0)).toBe(false);
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

describe('parseTimeOfDay', () => {
  it('returns null for undefined, empty string, or whitespace', () => {
    expect(parseTimeOfDay(undefined)).toBeNull();
    expect(parseTimeOfDay('')).toBeNull();
    expect(parseTimeOfDay('   ')).toBeNull();
  });

  it('parses valid HH:MM strings into minutes since midnight', () => {
    expect(parseTimeOfDay('00:00')).toBe(0);
    expect(parseTimeOfDay('09:30')).toBe(570);
    expect(parseTimeOfDay('23:59')).toBe(1439);
  });

  it('throws on invalid formats or out-of-range values', () => {
    expect(() => parseTimeOfDay('9:00')).toThrow();
    expect(() => parseTimeOfDay('24:00')).toThrow();
    expect(() => parseTimeOfDay('12:60')).toThrow();
    expect(() => parseTimeOfDay('invalid')).toThrow();
    expect(() => parseTimeOfDay('12:00:00')).toThrow();
  });
});

describe('isWithinTimeOfDay', () => {
  // Helper to build a UTC Date that corresponds to HH:MM in PKT (UTC+5)
  // E.g., 09:00 PKT -> 04:00 UTC
  const makePktDate = (pktHour: number, pktMinute: number) => {
    const utcHour = pktHour - 5;
    const day = utcHour < 0 ? 14 : 15;
    const hour = (utcHour + 24) % 24;
    return new Date(Date.UTC(2026, 5, day, hour, pktMinute, 0, 0));
  };

  it('returns true unconditionally when either or both bounds are null', () => {
    const d = makePktDate(12, 0);
    expect(isWithinTimeOfDay(d, null, null)).toBe(true);
    expect(isWithinTimeOfDay(d, 540, null)).toBe(true);
    expect(isWithinTimeOfDay(d, null, 1020)).toBe(true);
  });

  it('handles standard daytime window [09:00, 17:00) with half-open boundary', () => {
    const fromMin = 540;  // 09:00
    const toMin = 1020;   // 17:00

    // Inside
    expect(isWithinTimeOfDay(makePktDate(12, 0), fromMin, toMin)).toBe(true);
    // At lower boundary (inclusive)
    expect(isWithinTimeOfDay(makePktDate(9, 0), fromMin, toMin)).toBe(true);
    // Just below boundary
    expect(isWithinTimeOfDay(makePktDate(8, 59), fromMin, toMin)).toBe(false);
    // At upper boundary (exclusive, [from, to))
    expect(isWithinTimeOfDay(makePktDate(17, 0), fromMin, toMin)).toBe(false);
    // Above upper boundary
    expect(isWithinTimeOfDay(makePktDate(17, 1), fromMin, toMin)).toBe(false);
  });

  it('handles midnight-crossing window [22:00, 02:00)', () => {
    const fromMin = 1320; // 22:00
    const toMin = 120;    // 02:00

    // Inside late night (>= 22:00)
    expect(isWithinTimeOfDay(makePktDate(22, 0), fromMin, toMin)).toBe(true);
    expect(isWithinTimeOfDay(makePktDate(23, 30), fromMin, toMin)).toBe(true);
    // Inside early morning (< 02:00)
    expect(isWithinTimeOfDay(makePktDate(0, 0), fromMin, toMin)).toBe(true);
    expect(isWithinTimeOfDay(makePktDate(1, 59), fromMin, toMin)).toBe(true);
    // At upper boundary (exclusive)
    expect(isWithinTimeOfDay(makePktDate(2, 0), fromMin, toMin)).toBe(false);
    // Outside during the day
    expect(isWithinTimeOfDay(makePktDate(12, 0), fromMin, toMin)).toBe(false);
    expect(isWithinTimeOfDay(makePktDate(21, 59), fromMin, toMin)).toBe(false);
  });
});

