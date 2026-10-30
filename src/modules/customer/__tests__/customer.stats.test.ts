import { describe, it, expect } from 'vitest';
import { pickCustomerStat } from '../customer.controller.js';

const stat = (due: number) => ({ totalOrders: 1, totalSpent: due, outstandingDue: due });

describe('pickCustomerStat', () => {
  it('uses a customer\'s own id or phone stats, never another customer\'s of the same name', () => {
    const map = {
      'id:a': stat(10),
      'phone:03116184946': stat(2180),
      'name:awais': stat(2180),
    };
    const a = { id: 'a', name: 'Awais', phone: '0311-1111111' };
    const b = { id: 'b', name: 'Awais', phone: '0311-6184946' };
    const c = { id: 'c', name: 'Awais', phone: '0300-1200000' };
    expect(pickCustomerStat(a, map)?.outstandingDue).toBe(10);
    expect(pickCustomerStat(b, map)?.outstandingDue).toBe(2180);
    expect(pickCustomerStat(c, map)).toBeNull(); // a new "Awais" with a phone inherits nothing
  });

  it('falls back to the name only for a customer with no usable phone', () => {
    const map = { 'name:walk guest': stat(500) };
    expect(pickCustomerStat({ id: 'x', name: 'Walk Guest', phone: null }, map)?.outstandingDue).toBe(500);
    expect(pickCustomerStat({ id: 'y', name: 'Walk Guest', phone: '00000000000' }, map)?.outstandingDue).toBe(500);
    expect(pickCustomerStat({ id: 'z', name: 'Walk Guest', phone: '0300-1234567' }, map)).toBeNull();
  });

  it('returns null without a stats map', () => {
    expect(pickCustomerStat({ id: 'a', name: 'A', phone: null })).toBeNull();
  });
});
