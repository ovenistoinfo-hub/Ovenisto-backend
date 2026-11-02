import { describe, it, expect } from 'vitest';
import { reservationSchema, quoteReservationSchema, createOrderSchema } from '../website.schema.js';

const OUTLET = '143113a2-e108-41f7-81f7-03db9ba1e55c';
const ITEM = { menuItemId: '1600dc6c-469f-418c-8740-96c875cb3afd', name: 'Zinger', qty: 1 };
const base = { outletId: OUTLET, customerName: 'Test', customerPhone: '0300-1234567', date: '2026-12-01', time: '19:00' };

describe('reservationSchema', () => {
  it('keeps the old Dine In table booking working (defaults: Dine In, 1 guest, no items)', () => {
    const parsed = reservationSchema.parse(base);
    expect(parsed).toMatchObject({ orderType: 'Dine In', guestCount: 1, items: [] });
  });

  it('requires a pre-order for Take Away and Delivery', () => {
    expect(reservationSchema.safeParse({ ...base, orderType: 'Take Away' }).success).toBe(false);
    expect(reservationSchema.safeParse({ ...base, orderType: 'Take Away', items: [ITEM] }).success).toBe(true);
  });

  it('requires a 10+ character address for Delivery', () => {
    expect(reservationSchema.safeParse({ ...base, orderType: 'Delivery', items: [ITEM], deliveryAddress: 'short' }).success).toBe(false);
    expect(reservationSchema.safeParse({ ...base, orderType: 'Delivery', items: [ITEM], deliveryAddress: 'House 1, Street 2, Lahore' }).success).toBe(true);
  });

  it('rejects an unknown booking type', () => {
    expect(reservationSchema.safeParse({ ...base, orderType: 'Foodpanda', items: [ITEM] }).success).toBe(false);
  });
});

describe('quoteReservationSchema', () => {
  it('allows an empty Dine In quote but not an empty Delivery one', () => {
    expect(quoteReservationSchema.safeParse({ outletId: OUTLET, orderType: 'Dine In' }).success).toBe(true);
    expect(quoteReservationSchema.safeParse({ outletId: OUTLET, orderType: 'Delivery', items: [] }).success).toBe(false);
  });
});

describe('createOrderSchema paymentChoice', () => {
  const order = { outletId: OUTLET, orderType: 'Take Away', items: [ITEM], customerName: 'Test', customerPhone: '0300-1234567' };

  it('defaults to cash, so an older website keeps working', () => {
    expect(createOrderSchema.parse(order).paymentChoice).toBe('cash');
  });

  it('accepts online', () => {
    expect(createOrderSchema.parse({ ...order, paymentChoice: 'online' }).paymentChoice).toBe('online');
  });

  it('rejects anything else', () => {
    expect(createOrderSchema.safeParse({ ...order, paymentChoice: 'card' }).success).toBe(false);
  });
});

describe('createOrderSchema gift', () => {
  const delivery = {
    outletId: OUTLET, orderType: 'Delivery', items: [ITEM], customerName: 'Buyer', customerPhone: '0300-1234567',
    deliveryAddress: 'House 12, Street 4, DHA Lahore',
  };
  const gift = { recipientName: 'Sara Khan', recipientPhone: '0321-2222222', message: 'Happy birthday' };

  it('is optional, so an ordinary order is unchanged', () => {
    expect(createOrderSchema.parse(delivery).gift).toBeUndefined();
  });
  it('accepts a gift on a Delivery order', () => {
    expect(createOrderSchema.parse({ ...delivery, gift }).gift?.recipientName).toBe('Sara Khan');
  });
  it('refuses a gift on Take Away (a gift is delivered)', () => {
    expect(createOrderSchema.safeParse({ ...delivery, orderType: 'Take Away', gift }).success).toBe(false);
  });
  it('needs the recipient name and phone, and caps the card message', () => {
    expect(createOrderSchema.safeParse({ ...delivery, gift: { ...gift, recipientName: ' ' } }).success).toBe(false);
    expect(createOrderSchema.safeParse({ ...delivery, gift: { ...gift, recipientPhone: '' } }).success).toBe(false);
    expect(createOrderSchema.safeParse({ ...delivery, gift: { ...gift, message: 'x'.repeat(201) } }).success).toBe(false);
  });
});
