import { describe, it, expect } from 'vitest';
import { computeDeliveryFee, normalizePkPhone, toWebsiteOrderStatus, WebsiteConfig, readWebsiteConfig, isAcceptingOrders, validateReservationSlot, toWebsiteReservationStatus, resolveBranchContact, parseLocation, resolveDeliveryLocation, parseWebsiteBookingType, attachDealTags } from '../website.helpers.js';

describe('website.helpers.ts', () => {
  const dummyConfig: WebsiteConfig = {
    enabled: true,
    deliveryFee: 150,
    freeDeliveryAbove: 1000,
    minOrder: 500,
    prepTimeMinutes: 30,
    reservationsEnabled: true,
    location: null,
  };

  describe('computeDeliveryFee', () => {
    it('returns 0 for Take Away', () => {
      expect(computeDeliveryFee('Take Away', dummyConfig, 500)).toBe(0);
    });

  describe('resolveBranchContact', () => {
    const out = { address: 'Out Addr', phone: 'Out Phone', email: 'out@email', city: 'Out City' };
    const set = { outletId: 'o1', address: 'Set Addr', phone: 'Set Phone', email: 'set@email' };

    it('Settings wins over Outlet', () => {
      const res = resolveBranchContact(out, set, 'o1');
      expect(res.address).toBe('Set Addr');
      expect(res.phone).toBe('Set Phone');
      expect(res.email).toBe('set@email');
      expect(res.city).toBe('Out City');
    });

    it('blank Settings value falls back to Outlet', () => {
      const blankSet = { outletId: 'o1', address: '', phone: '   ', email: null };
      const res = resolveBranchContact(out, blankSet, 'o1');
      expect(res.address).toBe('Out Addr');
      expect(res.phone).toBe('Out Phone');
      expect(res.email).toBe('out@email');
      expect(res.city).toBe('Out City');
    });

    it('another branch\'s Settings row is ignored', () => {
      const res = resolveBranchContact(out, set, 'o2'); // target is o2, settings is for o1
      expect(res.address).toBe('Out Addr');
      expect(res.phone).toBe('Out Phone');
      expect(res.email).toBe('out@email');
      expect(res.city).toBe('Out City');
    });

    it('all empty gives nulls', () => {
      const emptyOut = { address: '', phone: null, email: '   ', city: undefined };
      const res = resolveBranchContact(emptyOut, null, 'o1');
      expect(res.address).toBe(null);
      expect(res.phone).toBe(null);
      expect(res.email).toBe(null);
      expect(res.city).toBe(null);
    });
  });

    it('returns deliveryFee for Delivery if under freeDeliveryAbove', () => {
      expect(computeDeliveryFee('Delivery', dummyConfig, 500)).toBe(150);
    });

    it('returns 0 for Delivery if at or above freeDeliveryAbove', () => {
      expect(computeDeliveryFee('Delivery', dummyConfig, 1000)).toBe(0);
      expect(computeDeliveryFee('Delivery', dummyConfig, 1500)).toBe(0);
    });

    it('always returns deliveryFee if freeDeliveryAbove is null', () => {
      const config = { ...dummyConfig, freeDeliveryAbove: null };
      expect(computeDeliveryFee('Delivery', config, 5000)).toBe(150);
    });
  });

  describe('normalizePkPhone', () => {
    it('normalizes valid PK numbers to formatted format', () => {
      expect(normalizePkPhone('0300-1234567')).toBe('0300-1234567');
      expect(normalizePkPhone('03001234567')).toBe('0300-1234567');
      expect(normalizePkPhone('+92 300 1234567')).toBe('0300-1234567');
      expect(normalizePkPhone('923001234567')).toBe('0300-1234567');
    });

    it('returns null for invalid numbers', () => {
      expect(normalizePkPhone('04235711234')).toBe(null);
      expect(normalizePkPhone('0300123')).toBe(null);
      expect(normalizePkPhone('')).toBe(null);
    });
  });

  describe('toWebsiteOrderStatus', () => {
    it('maps CANCELLED to cancelled', () => {
      expect(toWebsiteOrderStatus({ status: 'CANCELLED', type: 'DELIVERY' }, null)).toBe('cancelled');
    });

    it('maps PENDING to accepted if acceptedById is present, else pending', () => {
      expect(toWebsiteOrderStatus({ status: "PENDING", acceptedById: 'staff1', type: 'DELIVERY' }, null)).toBe('accepted');
      expect(toWebsiteOrderStatus({ status: "PENDING", acceptedById: null, type: 'DELIVERY' }, null)).toBe('pending');
    });

    it('maps SCHEDULED to accepted', () => {
      expect(toWebsiteOrderStatus({ status: 'SCHEDULED', type: 'DELIVERY' }, null)).toBe('accepted');
    });

    it('maps PREPARING to preparing', () => {
      expect(toWebsiteOrderStatus({ status: 'PREPARING', type: 'DELIVERY' }, null)).toBe('preparing');
    });

    it('maps READY based on type and assignment', () => {
      expect(toWebsiteOrderStatus({ status: 'READY', type: 'DELIVERY' }, 'dispatched')).toBe('out_for_delivery');
      expect(toWebsiteOrderStatus({ status: 'READY', type: 'TAKE_AWAY' }, 'dispatched')).toBe('ready');
      expect(toWebsiteOrderStatus({ status: 'READY', type: 'DELIVERY' }, null)).toBe('ready');
    });

    it('maps COMPLETED to completed', () => {
      expect(toWebsiteOrderStatus({ status: 'COMPLETED', type: 'DELIVERY' }, null)).toBe('completed');
    });

    it('maps anything else to pending', () => {
      expect(toWebsiteOrderStatus({ status: 'UNKNOWN_STATUS', type: 'DELIVERY' }, null)).toBe('pending');
    });
  });

  describe('readWebsiteConfig', () => {
    it('returns defaults for empty or invalid input', () => {
      const def = readWebsiteConfig(null);
      expect(def.enabled).toBe(false);
      expect(def.deliveryFee).toBe(0);
    });
  });

  describe('isAcceptingOrders', () => {
    it('returns true only if all flags are true', () => {
      expect(isAcceptingOrders({ outletActive: true, onlineOrders: true, config: { ...dummyConfig, enabled: true } })).toBe(true);
      expect(isAcceptingOrders({ outletActive: false, onlineOrders: true, config: { ...dummyConfig, enabled: true } })).toBe(false);
      expect(isAcceptingOrders({ outletActive: true, onlineOrders: false, config: { ...dummyConfig, enabled: true } })).toBe(false);
      expect(isAcceptingOrders({ outletActive: true, onlineOrders: true, config: { ...dummyConfig, enabled: false } })).toBe(false);
    });
  });

  describe('validateReservationSlot', () => {
    const nowMs = new Date('2026-09-29T15:00:00.000Z').getTime();

    it('accepts a valid future slot', () => {
      expect(validateReservationSlot({ date: '2026-09-30', time: '14:00', nowMs })).toBe(null);
    });

    it('rejects an earlier slot today (PKT)', () => {
      expect(validateReservationSlot({ date: '2026-09-29', time: '19:00', nowMs })).toBe('Cannot book in the past');
    });

    it('rejects a slot that is future in UTC but past in PKT', () => {
      expect(validateReservationSlot({ date: '2026-09-29', time: '18:00', nowMs })).toBe('Cannot book in the past');
    });

    it('rejects exactly current minute', () => {
      expect(validateReservationSlot({ date: '2026-09-29', time: '20:00', nowMs })).toBe('Cannot book in the past');
    });

    it('accepts later today', () => {
      expect(validateReservationSlot({ date: '2026-09-29', time: '21:00', nowMs })).toBe(null);
    });

    it('rejects > maxAdvanceDays', () => {
      expect(validateReservationSlot({ date: '2026-11-29', time: '12:00', nowMs, maxAdvanceDays: 60 })).toBe('Cannot book more than 60 days in advance');
    });

    it('accepts exactly maxAdvanceDays', () => {
      expect(validateReservationSlot({ date: '2026-11-28', time: '12:00', nowMs, maxAdvanceDays: 60 })).toBe(null);
    });

    it('rejects bad date format', () => {
      expect(validateReservationSlot({ date: '2026-02-30', time: '12:00', nowMs })).toBe('Invalid calendar date');
      expect(validateReservationSlot({ date: '02-30-2026', time: '12:00', nowMs })).toBe('Invalid date format (YYYY-MM-DD)');
    });

    it('rejects bad time format', () => {
      expect(validateReservationSlot({ date: '2026-09-30', time: '7pm', nowMs })).toBe('Invalid time format (HH:mm)');
      expect(validateReservationSlot({ date: '2026-09-30', time: '24:00', nowMs })).toBe('Invalid time format (HH:mm)');
    });
  });

  describe('toWebsiteReservationStatus', () => {
    it('maps correctly', () => {
      expect(toWebsiteReservationStatus('pending')).toBe('pending');
      expect(toWebsiteReservationStatus('confirmed')).toBe('confirmed');
      expect(toWebsiteReservationStatus('seated')).toBe('seated');
      expect(toWebsiteReservationStatus('completed')).toBe('completed');
      expect(toWebsiteReservationStatus('cancelled')).toBe('cancelled');
      expect(toWebsiteReservationStatus('noShow')).toBe('no_show');
      expect(toWebsiteReservationStatus('unknown_status_xyz')).toBe('pending');
    });
  });

  describe('parseLocation', () => {
    it('parses valid object', () => {
      expect(parseLocation({ lat: 31.47, lng: 74.3 })).toEqual({ lat: 31.47, lng: 74.3 });
    });
    it('parses numeric strings', () => {
      expect(parseLocation({ lat: "31.47", lng: "74.3" })).toEqual({ lat: 31.47, lng: 74.3 });
    });
    it('rejects out of range', () => {
      expect(parseLocation({ lat: 91, lng: 0 })).toBeNull();
      expect(parseLocation({ lat: 0, lng: 181 })).toBeNull();
    });
    it('rejects (0,0)', () => {
      expect(parseLocation({ lat: 0, lng: 0 })).toBeNull();
    });
    it('rejects missing or garbage', () => {
      expect(parseLocation(null)).toBeNull();
      expect(parseLocation("string")).toBeNull();
      expect(parseLocation(123)).toBeNull();
      expect(parseLocation([])).toBeNull();
      expect(parseLocation({ lat: 31 })).toBeNull();
    });
  });

  describe('resolveDeliveryLocation', () => {
    it('returns point for Delivery with valid point', () => {
      expect(resolveDeliveryLocation('Delivery', { lat: 31.47, lng: 74.3 })).toEqual({ lat: 31.47, lng: 74.3 });
    });
    it('returns null for Take Away with valid point', () => {
      expect(resolveDeliveryLocation('Take Away', { lat: 31.47, lng: 74.3 })).toBeNull();
    });
    it('returns null for Delivery with invalid point', () => {
      expect(resolveDeliveryLocation('Delivery', { lat: 0, lng: 0 })).toBeNull();
      expect(resolveDeliveryLocation('Delivery', null)).toBeNull();
      expect(resolveDeliveryLocation('Delivery', { lat: 91, lng: 0 })).toBeNull();
    });
    it('returns null for Dine In', () => {
      expect(resolveDeliveryLocation('Dine In', { lat: 31.47, lng: 74.3 })).toBeNull();
    });
  });

  describe('parseWebsiteBookingType', () => {
    it('accepts the three booking channels and nothing else', () => {
      expect(parseWebsiteBookingType('Dine In')).toBe('Dine In');
      expect(parseWebsiteBookingType('Take Away')).toBe('Take Away');
      expect(parseWebsiteBookingType('Delivery')).toBe('Delivery');
      expect(parseWebsiteBookingType('Foodpanda')).toBeNull();
      expect(parseWebsiteBookingType(undefined)).toBeNull();
    });
  });

  describe('attachDealTags', () => {
    const plain = { menuItemId: 'p1', variantId: null, dealLineId: null, name: 'Fries' };

    it('puts an option-combo pick back in its group', () => {
      const priced = [{ menuItemId: 'm1', variantId: 'v1', dealLineId: 'L1', name: 'Combo: Burger' }];
      const request = [{ menuItemId: 'm1', variantId: 'v1', dealLineId: 'L1', dealGroupId: 'g-main' }];
      expect(attachDealTags(priced, request)[0]).toMatchObject({ dealGroupId: 'g-main', dealRole: null });
    });

    it('restores the BUY/GET side of a Buy X Get Y line', () => {
      const priced = [
        { menuItemId: 'pizza', variantId: 'L', dealLineId: 'B1' },
        { menuItemId: 'drink', variantId: null, dealLineId: 'B1' },
      ];
      const request = [
        { menuItemId: 'drink', variantId: undefined, dealLineId: 'B1', dealRole: 'get' as const },
        { menuItemId: 'pizza', variantId: 'L', dealLineId: 'B1', dealRole: 'buy' as const },
      ];
      const tagged = attachDealTags(priced, request);
      expect(tagged[0].dealRole).toBe('buy');
      expect(tagged[1].dealRole).toBe('get');
    });

    it('gives two identical items in one deal line two different request rows', () => {
      const priced = [
        { menuItemId: 'can', variantId: null, dealLineId: 'L2' },
        { menuItemId: 'can', variantId: null, dealLineId: 'L2' },
      ];
      const request = [
        { menuItemId: 'can', variantId: null, dealLineId: 'L2', dealGroupId: 'g-drink-1' },
        { menuItemId: 'can', variantId: null, dealLineId: 'L2', dealGroupId: 'g-drink-2' },
      ];
      expect(attachDealTags(priced, request).map(l => l.dealGroupId)).toEqual(['g-drink-1', 'g-drink-2']);
    });

    it('leaves plain lines and unmatched deal lines untouched', () => {
      const orphan = { menuItemId: 'x', variantId: null, dealLineId: 'L9' };
      const tagged = attachDealTags([plain, orphan], [{ menuItemId: 'y', variantId: null, dealLineId: 'L9', dealGroupId: 'g' }]);
      expect(tagged[0]).toBe(plain);
      expect(tagged[1]).toBe(orphan);
    });
  });
});
