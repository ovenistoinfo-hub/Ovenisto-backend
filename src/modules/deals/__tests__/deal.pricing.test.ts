import { describe, it, expect } from 'vitest';
import {
  isDealCurrentlyValid,
  resolveChannelPrice,
  allocateDealDiscount,
  validateDealSelection,
  isItemEligibleForDiscount,
  mapDealOut,
  mapDealOutPublic,
  type DealForPricing,
} from '../deal.pricing.js';

function baseDeal(overrides: Partial<DealForPricing> = {}): DealForPricing {
  return {
    id: 'deal-1',
    type: 'COMBO',
    price: 1000,
    isActive: true,
    status: 'active',
    validFrom: '2026-01-01',
    validTo: null,
    ...overrides,
  };
}

describe('isDealCurrentlyValid', () => {
  const noonPktJan15 = Date.parse('2026-01-15T07:00:00.000Z'); // 12:00 PKT

  it('rejects an archived deal', () => {
    const result = isDealCurrentlyValid(baseDeal({ status: 'archived' }), noonPktJan15);
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/archived/i);
  });

  it('rejects an inactive deal', () => {
    const result = isDealCurrentlyValid(baseDeal({ isActive: false }), noonPktJan15);
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/not currently active/i);
  });

  it('rejects a deal that has not started yet', () => {
    const result = isDealCurrentlyValid(baseDeal({ validFrom: '2026-02-01' }), noonPktJan15);
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/starts on/i);
  });

  it('rejects an expired deal', () => {
    const result = isDealCurrentlyValid(baseDeal({ validTo: '2026-01-01' }), noonPktJan15);
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/expired/i);
  });

  it('accepts a deal with validTo === null (never expires)', () => {
    expect(isDealCurrentlyValid(baseDeal({ validTo: null }), noonPktJan15).valid).toBe(true);
  });

  it('accepts a deal inside a same-day time window', () => {
    const result = isDealCurrentlyValid(baseDeal({ startTime: '11:00', endTime: '15:00' }), noonPktJan15);
    expect(result.valid).toBe(true);
  });

  it('rejects a deal outside a same-day time window', () => {
    const result = isDealCurrentlyValid(baseDeal({ startTime: '17:00', endTime: '20:00' }), noonPktJan15);
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/only available/i);
  });

  it('accepts a deal inside a midnight-crossing window (23:30 PKT)', () => {
    const lateNight = Date.parse('2026-01-15T18:30:00.000Z'); // 23:30 PKT
    const result = isDealCurrentlyValid(baseDeal({ startTime: '22:00', endTime: '02:00' }), lateNight);
    expect(result.valid).toBe(true);
  });

  it('accepts a deal inside a midnight-crossing window (01:30 PKT)', () => {
    const earlyMorning = Date.parse('2026-01-14T20:30:00.000Z'); // 01:30 PKT next day
    const result = isDealCurrentlyValid(baseDeal({ startTime: '22:00', endTime: '02:00' }), earlyMorning);
    expect(result.valid).toBe(true);
  });

  it('rejects a deal outside a midnight-crossing window (10:00 PKT)', () => {
    const result = isDealCurrentlyValid(baseDeal({ startTime: '22:00', endTime: '02:00' }), noonPktJan15 - 2 * 60 * 60 * 1000);
    expect(result.valid).toBe(false);
  });

  it('rolls the PKT date forward across the UTC/PKT boundary (19:30 UTC = 00:30 next day PKT)', () => {
    // 2026-01-15T19:30:00Z + 5h = 2026-01-16T00:30 PKT — "today" is the 16th, not the 15th.
    const boundary = Date.parse('2026-01-15T19:30:00.000Z');
    const dealStartingThe16th = baseDeal({ validFrom: '2026-01-16' });
    expect(isDealCurrentlyValid(dealStartingThe16th, boundary).valid).toBe(true);
    const dealExpiringThe15th = baseDeal({ validTo: '2026-01-15' });
    expect(isDealCurrentlyValid(dealExpiringThe15th, boundary).valid).toBe(false);
  });
});

describe('resolveChannelPrice', () => {
  const record = { price: 500, dineInPrice: 480, takeAwayPrice: 460, deliveryPrice: null, foodpandaPrice: 0 };

  it('picks the matching channel price', () => {
    expect(resolveChannelPrice(record, 'Dine In')).toBe(480);
    expect(resolveChannelPrice(record, 'Take Away')).toBe(460);
  });

  it('falls back to base price when the channel price is null', () => {
    expect(resolveChannelPrice(record, 'Delivery')).toBe(500);
  });

  it('honors a channel price of exactly 0 (does not treat it as unset)', () => {
    expect(resolveChannelPrice(record, 'Foodpanda')).toBe(0);
  });

  it('falls back to base price for an unknown/undefined order type', () => {
    expect(resolveChannelPrice(record, undefined)).toBe(500);
    expect(resolveChannelPrice(record, 'Something Else')).toBe(500);
  });
});

describe('allocateDealDiscount', () => {
  it('sums exactly to the savings for an awkward 3-way split', () => {
    const result = allocateDealDiscount(1000, [400, 400, 400]);
    expect(result.reduce((s, v) => s + v, 0)).toBe(1000);
  });

  it('sums exactly for unequal weights', () => {
    const result = allocateDealDiscount(300, [100, 200, 300]);
    expect(result.reduce((s, v) => s + v, 0)).toBe(300);
    expect(result[2]).toBeGreaterThan(result[0]);
  });

  it('handles a single component', () => {
    expect(allocateDealDiscount(150, [500])).toEqual([150]);
  });

  it('splits evenly across all-zero weights', () => {
    const result = allocateDealDiscount(100, [0, 0]);
    expect(result.reduce((s, v) => s + v, 0)).toBe(100);
    expect(result[0]).toBeCloseTo(50, 2);
  });

  it('returns all zeros when savings is 0', () => {
    expect(allocateDealDiscount(0, [100, 200])).toEqual([0, 0]);
  });

  it('clamps negative savings to 0', () => {
    expect(allocateDealDiscount(-50, [100, 200])).toEqual([0, 0]);
  });

  it('returns an empty array for an empty line list', () => {
    expect(allocateDealDiscount(100, [])).toEqual([]);
  });
});

describe('validateDealSelection', () => {
  const comboDeal = baseDeal({
    type: 'COMBO',
    components: [
      { id: 'c1', menuItemId: 'burger', variantId: null, qty: 1 },
      { id: 'c2', menuItemId: 'fries', variantId: null, qty: 2 },
    ],
  });

  it('accepts a selection matching the fixed components exactly', () => {
    const result = validateDealSelection(comboDeal, [
      { menuItemId: 'burger', qty: 1 },
      { menuItemId: 'fries', qty: 2 },
    ]);
    expect(result).toHaveLength(2);
  });

  it('rejects an extra injected component', () => {
    expect(() =>
      validateDealSelection(comboDeal, [
        { menuItemId: 'burger', qty: 1 },
        { menuItemId: 'fries', qty: 2 },
        { menuItemId: 'extra-drink', qty: 1 },
      ])
    ).toThrow();
  });

  it('rejects a missing component', () => {
    expect(() => validateDealSelection(comboDeal, [{ menuItemId: 'burger', qty: 1 }])).toThrow();
  });

  it('rejects a tampered quantity on a fixed component', () => {
    expect(() =>
      validateDealSelection(comboDeal, [
        { menuItemId: 'burger', qty: 5 },
        { menuItemId: 'fries', qty: 2 },
      ])
    ).toThrow();
  });

  const optionDeal = baseDeal({
    type: 'OPTION_COMBO',
    optionGroups: [
      {
        id: 'g1',
        label: 'Choose your drink',
        minSelections: 1,
        maxSelections: 1,
        options: [
          { id: 'o1', menuItemId: 'coke', variantId: null, extraPrice: 0 },
          { id: 'o2', menuItemId: 'sprite', variantId: null, extraPrice: 0 },
        ],
      },
    ],
  });

  it('accepts an in-allow-list option pick', () => {
    const result = validateDealSelection(optionDeal, [{ groupId: 'g1', menuItemId: 'coke' }]);
    expect(result).toHaveLength(1);
    expect(result[0].menuItemId).toBe('coke');
  });

  it('rejects a pick not in the group\'s allow-list', () => {
    expect(() => validateDealSelection(optionDeal, [{ groupId: 'g1', menuItemId: 'pepsi' }])).toThrow();
  });

  it('rejects too few selections for a group', () => {
    expect(() => validateDealSelection(optionDeal, [])).toThrow();
  });

  it('rejects too many selections for a group', () => {
    expect(() =>
      validateDealSelection(optionDeal, [
        { groupId: 'g1', menuItemId: 'coke' },
        { groupId: 'g1', menuItemId: 'sprite' },
      ])
    ).toThrow();
  });

  it('rejects a pick referencing an unknown group', () => {
    expect(() => validateDealSelection(optionDeal, [{ groupId: 'unknown-group', menuItemId: 'coke' }])).toThrow();
  });
});

describe('mapDealOut', () => {
  it('converts Decimal-like fields to Number and the enum member to its wire string', () => {
    const raw = {
      id: 'd1',
      type: 'COMBO',
      price: { toString: () => '1200' } as any, // Prisma Decimal stand-in
      dineInPrice: null,
    };
    // Number() on an object with toString works via coercion
    const mapped = mapDealOut(raw);
    expect(mapped.type).toBe('combo');
    expect(mapped.price).toBe(1200);
  });

  it('maps OPTION_COMBO to option_combo', () => {
    expect(mapDealOut({ id: 'd2', type: 'OPTION_COMBO', price: 500 }).type).toBe('option_combo');
  });

  it('returns null/undefined unchanged', () => {
    expect(mapDealOut(null)).toBeNull();
  });
});

describe('mapDealOutPublic', () => {
  it('omits internal channel prices and outletIds', () => {
    const mapped = mapDealOutPublic({
      id: 'd1', type: 'COMBO', price: 1000,
      dineInPrice: 950, takeAwayPrice: 900, deliveryPrice: 920, foodpandaPrice: 980,
      outletIds: ['outlet-1'], status: 'active',
    });
    expect(mapped.price).toBe(950); // dineInPrice wins
    expect(mapped).not.toHaveProperty('takeAwayPrice');
    expect(mapped).not.toHaveProperty('deliveryPrice');
    expect(mapped).not.toHaveProperty('foodpandaPrice');
    expect(mapped).not.toHaveProperty('outletIds');
  });

  it('falls back to base price when dineInPrice is unset', () => {
    const mapped = mapDealOutPublic({ id: 'd1', type: 'COMBO', price: 1000 });
    expect(mapped.price).toBe(1000);
  });
});

describe('isItemEligibleForDiscount', () => {
  const percentDeal = baseDeal({
    type: 'PERCENTAGE',
    price: null,
    discountPercent: 20,
    applicableItems: ['burger'],
    applicableCategories: ['drinks-cat'],
  });

  it('matches an item explicitly listed in applicableItems', () => {
    expect(isItemEligibleForDiscount(percentDeal, { menuItemId: 'burger', categoryId: 'other-cat' })).toBe(true);
  });

  it('matches an item whose category is in applicableCategories', () => {
    expect(isItemEligibleForDiscount(percentDeal, { menuItemId: 'coke', categoryId: 'drinks-cat' })).toBe(true);
  });

  it('rejects an item matching neither list', () => {
    expect(isItemEligibleForDiscount(percentDeal, { menuItemId: 'fries', categoryId: 'sides-cat' })).toBe(false);
  });

  it('rejects an item with no category when only categories are scoped', () => {
    const categoryOnlyDeal = baseDeal({ type: 'PERCENTAGE', applicableItems: [], applicableCategories: ['drinks-cat'] });
    expect(isItemEligibleForDiscount(categoryOnlyDeal, { menuItemId: 'mystery-item', categoryId: null })).toBe(false);
  });

  it('never matches anything when both lists are empty (no silent chain-wide discount)', () => {
    const unscopedDeal = baseDeal({ type: 'PERCENTAGE', applicableItems: [], applicableCategories: [] });
    expect(isItemEligibleForDiscount(unscopedDeal, { menuItemId: 'anything', categoryId: 'any-cat' })).toBe(false);
  });
});

describe('mapDealOut with new deal types', () => {
  it('maps PERCENTAGE to percentage, BUY_X_GET_Y to buy_x_get_y', () => {
    expect(mapDealOut({ id: 'd3', type: 'PERCENTAGE', price: null }).type).toBe('percentage');
    expect(mapDealOut({ id: 'd4', type: 'BUY_X_GET_Y', price: null }).type).toBe('buy_x_get_y');
  });

  it('keeps price as null rather than coercing to 0 for a discount-type deal', () => {
    const mapped = mapDealOut({ id: 'd6', type: 'PERCENTAGE', price: null, discountPercent: 15 });
    expect(mapped.price).toBeNull();
    expect(mapped.discountPercent).toBe(15);
  });
});
