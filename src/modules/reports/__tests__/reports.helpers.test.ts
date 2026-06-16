import { describe, it, expect } from 'vitest';
import { parseDateRange, buildOrderWhere, computeCogs } from '../reports.helpers.js';

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
