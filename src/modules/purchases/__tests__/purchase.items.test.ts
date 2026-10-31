import { describe, it, expect } from 'vitest';
import { invalidPurchaseItem } from '../purchase.items.js';

describe('invalidPurchaseItem', () => {
  it('accepts normal lines, with or without waste', () => {
    expect(invalidPurchaseItem([{ ingredientId: 'a', qty: 10, wasteQty: 2, unitPrice: 50 }])).toBeNull();
    expect(invalidPurchaseItem([{ ingredientId: 'a', qty: 1, unitPrice: 0 }])).toBeNull();
    expect(invalidPurchaseItem([{ ingredientId: 'a', qty: 5, wasteQty: 5, unitPrice: 10 }])).toBeNull();
  });

  it('rejects a zero, negative or non-numeric quantity', () => {
    expect(invalidPurchaseItem([{ name: 'Water', qty: -5, unitPrice: 50 }])).toMatch(/Water/);
    expect(invalidPurchaseItem([{ qty: 0, unitPrice: 1 }])).not.toBeNull();
    expect(invalidPurchaseItem([{ qty: 'abc', unitPrice: 1 }])).not.toBeNull();
  });

  it('rejects waste above the purchased quantity or below zero', () => {
    expect(invalidPurchaseItem([{ qty: 1, wasteQty: 5, unitPrice: 50 }])).toMatch(/Waste/);
    expect(invalidPurchaseItem([{ qty: 5, wasteQty: -1, unitPrice: 50 }])).toMatch(/Waste/);
  });

  it('rejects a negative unit price', () => {
    expect(invalidPurchaseItem([{ qty: 1, unitPrice: -3 }])).toMatch(/price/);
  });
});
