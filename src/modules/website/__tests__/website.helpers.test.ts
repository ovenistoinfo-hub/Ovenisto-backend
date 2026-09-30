import { describe, it, expect } from 'vitest';
import { computeDeliveryFee, normalizePkPhone, toWebsiteOrderStatus, WebsiteConfig, readWebsiteConfig, isAcceptingOrders, validateReservationSlot, toWebsiteReservationStatus } from '../website.helpers.js';

describe('website.helpers.ts', () => {
  const dummyConfig: WebsiteConfig = {
    enabled: true,
    deliveryFee: 150,
    freeDeliveryAbove: 1000,
    minOrder: 500,
    prepTimeMinutes: 30,
    reservationsEnabled: true,
  };

  describe('computeDeliveryFee', () => {
    it('returns 0 for Take Away', () => {
      expect(computeDeliveryFee('Take Away', dummyConfig, 500)).toBe(0);
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
});
