import { describe, it, expect } from 'vitest';
import { assertServedAt } from '../mealTimes.js';

const meals = [
  { id: 'bf', name: 'Breakfast', hours: { open: '08:00', close: '11:00' } },
  { id: 'dn', name: 'Dinner', hours: { open: '19:00', close: '02:00' } },
  { id: 'all', name: 'All-Day Dining', hours: null },
];

describe('assertServedAt', () => {
  it('passes a dish inside its window, an untagged dish and an all-day dish', () => {
    expect(() => assertServedAt({ name: 'Paratha', mealTypeIds: ['bf'] }, meals, 9 * 60, 'x')).not.toThrow();
    expect(() => assertServedAt({ name: 'Fries', mealTypeIds: [] }, meals, 13 * 60, 'x')).not.toThrow();
    expect(() => assertServedAt({ name: 'Tea', mealTypeIds: ['bf', 'all'] }, meals, 13 * 60, 'x')).not.toThrow();
  });

  it('refuses a dish outside every window, naming them', () => {
    expect(() => assertServedAt({ name: 'Paratha', mealTypeIds: ['bf', 'dn'] }, meals, 13 * 60, 'Remove it.'))
      .toThrow('"Paratha" is only served during Breakfast (8:00 AM – 11:00 AM) or Dinner (7:00 PM – 2:00 AM). Remove it.');
  });
});
