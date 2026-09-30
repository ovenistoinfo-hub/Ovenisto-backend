import { describe, it, expect } from 'vitest';
import { requiresAcceptance, isAwaitingAcceptance } from '../order.acceptance.js';

describe('order.acceptance.ts', () => {
  describe('requiresAcceptance', () => {
    it('returns true for website orders', () => {
      expect(requiresAcceptance({ type: 'DELIVERY', orderSource: 'website' })).toBe(true);
    });

    it('returns true for self orders', () => {
      expect(requiresAcceptance({ type: 'SELF_ORDER', orderSource: null })).toBe(true);
    });

    it('returns false for POS or Waiter orders', () => {
      expect(requiresAcceptance({ type: 'POS', orderSource: null })).toBe(false);
      expect(requiresAcceptance({ type: 'WAITER', orderSource: null })).toBe(false);
    });
  });

  describe('isAwaitingAcceptance', () => {
    it('returns true if order requires acceptance and has no acceptedById', () => {
      expect(isAwaitingAcceptance({ type: 'DELIVERY', orderSource: 'website', status: 'PENDING', acceptedById: null })).toBe(true);
      expect(isAwaitingAcceptance({ type: 'SELF_ORDER', orderSource: null, status: 'PENDING', acceptedById: null })).toBe(true);
    });

    it('returns false if order requires acceptance but is already accepted', () => {
      expect(isAwaitingAcceptance({ type: 'DELIVERY', orderSource: 'website', status: 'PENDING', acceptedById: 'user-1' })).toBe(false);
      expect(isAwaitingAcceptance({ type: 'SELF_ORDER', orderSource: null, status: 'PENDING', acceptedById: 'user-1' })).toBe(false);
    });

    it('returns false if order source does not require acceptance', () => {
      expect(isAwaitingAcceptance({ type: 'POS', orderSource: null, status: 'PENDING', acceptedById: null })).toBe(false);
    });
    
    it('returns false if order requires acceptance but status is not PENDING', () => {
      expect(isAwaitingAcceptance({ type: 'DELIVERY', orderSource: 'website', status: 'ACCEPTED', acceptedById: null })).toBe(false);
    });
  });
});
