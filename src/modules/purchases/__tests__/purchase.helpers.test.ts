import { describe, it, expect } from 'vitest';
import { getPurchaseOutletId } from '../purchase.controller.js';

describe('getPurchaseOutletId', () => {
  it('warehouse-linked purchase → the WAREHOUSE outlet, not the purchase column', () => {
    expect(getPurchaseOutletId({
      outletId: 'stale-o1', warehouseId: 'wh1', warehouse: { outletId: 'o2' },
    })).toBe('o2');
  });

  it('warehouse-linked purchase whose warehouse is central MAIN (null) → null', () => {
    expect(getPurchaseOutletId({
      outletId: 'stale-o1', warehouseId: 'wh1', warehouse: { outletId: null },
    })).toBeNull();
  });

  it('warehouse-linked but warehouse relation not loaded → null, never the stale column', () => {
    expect(getPurchaseOutletId({
      outletId: 'stale-o1', warehouseId: 'wh1',
    })).toBeNull();
  });

  it('no warehouse → falls back to the purchase outletId column', () => {
    expect(getPurchaseOutletId({
      outletId: 'o1', warehouseId: null, warehouse: null,
    })).toBe('o1');
  });

  it('no warehouse and no outlet → null (chain-level purchase)', () => {
    expect(getPurchaseOutletId({ outletId: null, warehouseId: null, warehouse: null })).toBeNull();
  });
});
