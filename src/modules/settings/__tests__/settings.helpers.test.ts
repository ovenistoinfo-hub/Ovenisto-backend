import { describe, it, expect } from 'vitest';
import { mergePaymentMethods, DEFAULT_PAYMENT_METHODS } from '../settings.helpers.js';

describe('mergePaymentMethods', () => {
  it('merges Main and DHA lists correctly', () => {
    const main = ['Cash', 'Credit Card', 'Account', 'JazzCash', 'EasyPaisa'];
    const dha = ['Cash', 'Credit Card', 'Debit Card', 'JazzCash', 'EasyPaisa', 'Bank Transfer'];
    const merged = mergePaymentMethods([main, dha]);
    expect(merged).toEqual(['Cash', 'Credit Card', 'Account', 'JazzCash', 'EasyPaisa', 'Debit Card', 'Bank Transfer']);
  });

  it('handles case-duplicates', () => {
    const list1 = ['CASH', 'credit card'];
    const list2 = ['cash', 'Credit Card', 'Account'];
    const merged = mergePaymentMethods([list1, list2]);
    expect(merged).toEqual(['CASH', 'credit card', 'Account']);
  });

  it('returns default if empty', () => {
    expect(mergePaymentMethods([])).toEqual(DEFAULT_PAYMENT_METHODS);
    expect(mergePaymentMethods([[], []])).toEqual(DEFAULT_PAYMENT_METHODS);
  });
});

