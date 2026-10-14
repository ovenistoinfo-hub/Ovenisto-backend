import { describe, it, expect } from 'vitest';
import { normalizeAdvanceHours } from '../menu.controller.js';

describe('normalizeAdvanceHours', () => {
  it('keeps whole hours from 1 to 720 and clears the rest', () => {
    expect(normalizeAdvanceHours(24)).toBe(24);
    expect(normalizeAdvanceHours('6')).toBe(6);
    expect(normalizeAdvanceHours(2.7)).toBe(2);
    expect(normalizeAdvanceHours(1000)).toBe(720);
    expect(normalizeAdvanceHours(0)).toBeNull();
    expect(normalizeAdvanceHours('')).toBeNull();
    expect(normalizeAdvanceHours(null)).toBeNull();
    expect(normalizeAdvanceHours('abc')).toBeNull();
  });
});
