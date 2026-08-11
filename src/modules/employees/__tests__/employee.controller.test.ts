import { describe, it, expect } from 'vitest';
import { validateBody } from '../employee.controller.js';

const validBody = {
  firstName: 'Ali',
  phone: '0300-1234567',
  designation: 'Waiter',
  hireDate: '2026-01-01',
  rateType: 'Monthly',
  rate: 30000,
  email: 'ali@ovenisto.com',
};

describe('validateBody', () => {
  it('passes with all required fields present, including email', () => {
    expect(() => validateBody(validBody)).not.toThrow();
  });

  it('throws when email is missing', () => {
    const { email, ...rest } = validBody;
    expect(() => validateBody(rest)).toThrow('email is required');
  });

  it('throws when email is an empty string', () => {
    expect(() => validateBody({ ...validBody, email: '' })).toThrow('email is required');
  });

  it('throws when rateType is not one of the allowed values', () => {
    expect(() => validateBody({ ...validBody, rateType: 'Yearly' })).toThrow(/rateType must be one of/);
  });

  it('still throws when firstName is missing (pre-existing required field)', () => {
    const { firstName, ...rest } = validBody;
    expect(() => validateBody(rest)).toThrow('firstName is required');
  });
});
