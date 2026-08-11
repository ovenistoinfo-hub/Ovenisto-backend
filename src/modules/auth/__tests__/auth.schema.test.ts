import { describe, it, expect } from 'vitest';
import { createUserSchema } from '../auth.schema.js';

const base = {
  name: 'Ali',
  email: 'ali@ovenisto.com',
  password: 'secret1',
  role: 'Waiter',
};

describe('createUserSchema — employee-link requirement', () => {
  it('rejects a non-exempt role with no employeeId', () => {
    const result = createUserSchema.safeParse(base);
    expect(result.success).toBe(false);
  });

  it('rejects a non-exempt role with an empty-string employeeId', () => {
    const result = createUserSchema.safeParse({ ...base, employeeId: '' });
    expect(result.success).toBe(false);
  });

  it('accepts a non-exempt role with a valid employeeId', () => {
    const result = createUserSchema.safeParse({
      ...base,
      employeeId: '11111111-1111-1111-1111-111111111111',
    });
    expect(result.success).toBe(true);
  });

  it('accepts Super Admin with no employeeId', () => {
    const result = createUserSchema.safeParse({ ...base, role: 'Super Admin' });
    expect(result.success).toBe(true);
  });

  it('accepts Admin with no employeeId', () => {
    const result = createUserSchema.safeParse({ ...base, role: 'Admin' });
    expect(result.success).toBe(true);
  });

  it('accepts Customer Screen with no employeeId', () => {
    const result = createUserSchema.safeParse({ ...base, role: 'Customer Screen' });
    expect(result.success).toBe(true);
  });
});
