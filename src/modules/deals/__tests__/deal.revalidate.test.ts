import { describe, it, expect } from 'vitest';
import { withDealItemKeys } from '../deal.revalidate.js';

describe('withDealItemKeys', () => {
  it('leaves a plain (non-deal) item with a null key', () => {
    const [out] = withDealItemKeys([{ name: 'Coke', dealId: null, dealLineId: null }]);
    expect(out.dealItemKey).toBeNull();
  });

  it('gives each deal item a stable, distinct key within its dealLineId', () => {
    const out = withDealItemKeys([
      { name: 'Pizza', dealId: 'd1', dealLineId: 'line-1' },
      { name: 'Drink', dealId: 'd1', dealLineId: 'line-1' },
    ]);
    expect(out[0].dealItemKey).toBe('line-1#0');
    expect(out[1].dealItemKey).toBe('line-1#1');
    expect(out[0].dealItemKey).not.toBe(out[1].dealItemKey);
  });

  it('keeps separate deal redemptions on separate counters', () => {
    const out = withDealItemKeys([
      { name: 'Pizza', dealId: 'd1', dealLineId: 'line-1' },
      { name: 'Pizza', dealId: 'd1', dealLineId: 'line-2' },
    ]);
    expect(out[0].dealItemKey).toBe('line-1#0');
    expect(out[1].dealItemKey).toBe('line-2#0');
  });

  it('gives the buy and get side of a BOGO deal on the same item distinct keys', () => {
    // "Buy 1 Pizza, Get 1 Pizza Free" — both lines share menuItemId, so
    // dealItemKey (not menuItemId) must be what disambiguates their tickets.
    const out = withDealItemKeys([
      { name: 'Pizza', dealId: 'd1', dealLineId: 'line-1', dealRole: 'buy' },
      { name: 'Pizza (Free)', dealId: 'd1', dealLineId: 'line-1', dealRole: 'get' },
    ]);
    expect(out[0].dealItemKey).toBe('line-1#0');
    expect(out[1].dealItemKey).toBe('line-1#1');
  });
});
