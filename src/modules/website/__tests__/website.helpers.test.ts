import { describe, it, expect } from 'vitest';
import { readWebsiteConfig, parseWebsiteOrderType, isAcceptingOrders } from '../website.helpers.js';

describe('website.helpers', () => {
  describe('readWebsiteConfig', () => {
    it('returns defaults for garbage input', () => {
      const defaults = { enabled: false, deliveryFee: 0, freeDeliveryAbove: null, minOrder: 0, prepTimeMinutes: 30 };
      expect(readWebsiteConfig(null)).toEqual(defaults);
      expect(readWebsiteConfig('garbage')).toEqual(defaults);
      expect(readWebsiteConfig([])).toEqual(defaults);
    });

    it('reads canonical seed shape', () => {
      expect(readWebsiteConfig({ enabled: true, deliveryFee: 150, minOrder: 500, freeDeliveryAbove: 2000, prepTimeMinutes: 45 })).toEqual({
        enabled: true,
        deliveryFee: 150,
        freeDeliveryAbove: 2000,
        minOrder: 500,
        prepTimeMinutes: 45,
      });
    });

    it('reads legacy string shape and ignores unused fields', () => {
      const legacy = { enabled: "true", deliveryRadius: "10", minOrder: "500", deliveryCharges: "100", prepTime: "25", autoAccept: false };
      expect(readWebsiteConfig(legacy)).toEqual({
        enabled: true,
        deliveryFee: 100,
        freeDeliveryAbove: null,
        minOrder: 500,
        prepTimeMinutes: 25,
      });
    });

    it('canonical keys win when both exist', () => {
      const mixed = { deliveryFee: 200, deliveryCharges: 100, prepTimeMinutes: 40, prepTime: 20 };
      const res = readWebsiteConfig(mixed);
      expect(res.deliveryFee).toBe(200);
      expect(res.prepTimeMinutes).toBe(40);
    });

    it('handles negative or NaN values with defaults', () => {
      expect(readWebsiteConfig({ deliveryFee: -50, minOrder: 'abc', prepTimeMinutes: -10 })).toEqual({
        enabled: false,
        deliveryFee: 0,
        freeDeliveryAbove: null,
        minOrder: 0,
        prepTimeMinutes: 30,
      });
    });
  });

  describe('parseWebsiteOrderType', () => {
    it('parses valid order types', () => {
      expect(parseWebsiteOrderType('Delivery')).toBe('Delivery');
      expect(parseWebsiteOrderType('Take Away')).toBe('Take Away');
    });

    it('returns null for invalid ones', () => {
      expect(parseWebsiteOrderType('Dine In')).toBeNull();
      expect(parseWebsiteOrderType('Random')).toBeNull();
      expect(parseWebsiteOrderType(null)).toBeNull();
    });
  });

  describe('isAcceptingOrders', () => {
    it('true only when outlet, online orders and config are active', () => {
      const config = { enabled: true, deliveryFee: 0, freeDeliveryAbove: null, minOrder: 0, prepTimeMinutes: 30 };
      expect(isAcceptingOrders({ outletActive: true, onlineOrders: true, config })).toBe(true);
      expect(isAcceptingOrders({ outletActive: false, onlineOrders: true, config })).toBe(false);
      expect(isAcceptingOrders({ outletActive: true, onlineOrders: false, config })).toBe(false);
      expect(isAcceptingOrders({ outletActive: true, onlineOrders: true, config: { ...config, enabled: false } })).toBe(false);
    });
  });
});
