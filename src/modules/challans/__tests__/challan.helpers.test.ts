import { describe, it, expect } from 'vitest';
import { computeChallanSettlement } from '../challan.helpers.js';

describe('computeChallanSettlement', () => {
  it('computes subtotal from qty × unitPrice across items', () => {
    const result = computeChallanSettlement({
      items: [{ qty: 10, unitPrice: 50 }, { qty: 4, unitPrice: 25 }],
      tax: 0,
      shippingCost: 0,
      miscAmount: 0,
      paid: 0,
    });
    expect(result.subtotal).toBe(600); // 10*50 + 4*25
  });

  it('total = subtotal + tax + shippingCost + miscAmount', () => {
    const result = computeChallanSettlement({
      items: [{ qty: 10, unitPrice: 50 }],
      tax: 50,
      shippingCost: 20,
      miscAmount: 10,
      paid: 0,
    });
    expect(result.total).toBe(580); // 500 + 50 + 20 + 10
  });

  it('marks "paid" and zero due when paid covers the full total', () => {
    const result = computeChallanSettlement({
      items: [{ qty: 10, unitPrice: 50 }],
      tax: 0,
      shippingCost: 0,
      miscAmount: 0,
      paid: 500,
    });
    expect(result.due).toBe(0);
    expect(result.paymentStatus).toBe('paid');
  });

  it('marks "partial" and computes the remainder when paid is less than total', () => {
    const result = computeChallanSettlement({
      items: [{ qty: 10, unitPrice: 50 }],
      tax: 50,
      shippingCost: 20,
      miscAmount: 10,
      paid: 300,
    });
    expect(result.total).toBe(580);
    expect(result.due).toBe(280);
    expect(result.paymentStatus).toBe('partial');
  });

  it('marks "unpaid" when paid is zero and there is a due amount', () => {
    const result = computeChallanSettlement({
      items: [{ qty: 10, unitPrice: 50 }],
      tax: 0,
      shippingCost: 0,
      miscAmount: 0,
      paid: 0,
    });
    expect(result.due).toBe(500);
    expect(result.paymentStatus).toBe('unpaid');
  });

  it('clamps due at 0 when paid exceeds total (never a negative due)', () => {
    const result = computeChallanSettlement({
      items: [{ qty: 10, unitPrice: 50 }],
      tax: 0,
      shippingCost: 0,
      miscAmount: 0,
      paid: 700,
    });
    expect(result.due).toBe(0);
    expect(result.paymentStatus).toBe('paid');
  });

  it('rounds money values to 2 decimal places', () => {
    const result = computeChallanSettlement({
      items: [{ qty: 3, unitPrice: 10.005 }],
      tax: 0,
      shippingCost: 0,
      miscAmount: 0,
      paid: 0,
    });
    expect(result.subtotal).toBe(30.02); // 30.015 rounded
    expect(result.total).toBe(30.02);
  });
});
