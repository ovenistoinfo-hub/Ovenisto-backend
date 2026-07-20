import { describe, it, expect } from 'vitest';
import { isStockBatchExpired, isProductionBatchExpired } from '../autoExpiry.js';

describe('isStockBatchExpired', () => {
  const now = new Date('2026-07-20T12:00:00.000Z');

  it('returns true if explicit expiryDate is past', () => {
    const expiredDate = new Date('2026-07-20T11:59:59.000Z');
    expect(isStockBatchExpired(new Date(), expiredDate, null, null, now)).toBe(true);
  });

  it('returns false if explicit expiryDate is future', () => {
    const futureDate = new Date('2026-07-20T12:00:01.000Z');
    expect(isStockBatchExpired(new Date(), futureDate, null, null, now)).toBe(false);
  });

  it('uses shelfLifeMinutes when expiryDate is null', () => {
    const createdAt = new Date('2026-07-20T10:00:00.000Z'); // 2 hours ago
    expect(isStockBatchExpired(createdAt, null, 60, null, now)).toBe(true); // 60 min shelf life -> expired 1h ago
    expect(isStockBatchExpired(createdAt, null, 180, null, now)).toBe(false); // 180 min shelf life -> 1h remaining
  });

  it('falls back to ingredient.shelfLifeHours when shelfLifeMinutes and expiryDate are null', () => {
    const createdAt = new Date('2026-07-20T08:00:00.000Z'); // 4 hours ago
    expect(isStockBatchExpired(createdAt, null, null, 3, now)).toBe(true); // 3h shelf life -> expired 1h ago
    expect(isStockBatchExpired(createdAt, null, null, 8, now)).toBe(false); // 8h shelf life -> 4h remaining
  });

  it('returns false for standard non-perishable stock when all expiry fields are null', () => {
    const createdAt = new Date('2026-01-01T00:00:00.000Z');
    expect(isStockBatchExpired(createdAt, null, null, null, now)).toBe(false);
  });
});

describe('isProductionBatchExpired', () => {
  const now = new Date('2026-07-20T12:00:00.000Z');

  it('returns true when batchShelfLifeMinutes expired', () => {
    const createdAt = new Date('2026-07-20T10:00:00.000Z'); // 2 hours ago
    expect(isProductionBatchExpired(createdAt, 60, null, now)).toBe(true);
    expect(isProductionBatchExpired(createdAt, 180, null, now)).toBe(false);
  });

  it('falls back to itemShelfLifeHours when batchShelfLifeMinutes is null', () => {
    const createdAt = new Date('2026-07-20T08:00:00.000Z'); // 4 hours ago
    expect(isProductionBatchExpired(createdAt, null, 3, now)).toBe(true);
    expect(isProductionBatchExpired(createdAt, null, 8, now)).toBe(false);
  });

  it('returns false when no shelf life is configured', () => {
    const createdAt = new Date('2026-01-01T00:00:00.000Z');
    expect(isProductionBatchExpired(createdAt, null, null, now)).toBe(false);
  });
});
