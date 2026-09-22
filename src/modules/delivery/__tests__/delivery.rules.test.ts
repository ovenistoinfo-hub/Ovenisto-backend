import { describe, it, expect } from 'vitest';
import {
  normalizeOrderStatus,
  isOrderReadyForDispatch,
  canDispatch,
  RIDER_TRANSITIONS,
  isRiderTransitionAllowed,
} from '../delivery.rules.js';

describe('normalizeOrderStatus', () => {
  const cases: [input: string | null | undefined, expected: string][] = [
    ['READY', 'ready'],
    ['Ready', 'ready'],
    ['ready', 'ready'],
    ['  READY  ', 'ready'],
    ['PENDING', 'pending'],
    ['PREPARING', 'preparing'],
    ['COMPLETED', 'completed'],
    ['CANCELLED', 'cancelled'],
    ['SCHEDULED', 'scheduled'],
    ['', ''],
    [null, ''],
    [undefined, ''],
  ];

  it.each(cases)('normalizeOrderStatus(%j) -> %j', (input, expected) => {
    expect(normalizeOrderStatus(input)).toBe(expected);
  });
});

describe('isOrderReadyForDispatch', () => {
  const cases: [status: string | null | undefined, expected: boolean][] = [
    ['READY', true],
    ['ready', true],
    ['Ready', true],
    ['COMPLETED', true],
    ['completed', true],
    ['Completed', true],
    ['PENDING', false],
    ['pending', false],
    ['PREPARING', false],
    ['preparing', false],
    ['CANCELLED', false],
    ['cancelled', false],
    ['SCHEDULED', false],
    ['scheduled', false],
    ['UNKNOWN', false],
    ['', false],
    [null, false],
    [undefined, false],
  ];

  it.each(cases)('isOrderReadyForDispatch(%j) -> %j', (status, expected) => {
    expect(isOrderReadyForDispatch(status)).toBe(expected);
  });
});

describe('canDispatch', () => {
  const cases: [
    orderStatus: string | null | undefined,
    assignmentStatus: string | null | undefined,
    expected: boolean
  ][] = [
    // Valid cases: assignment is accepted AND order is ready/completed
    ['READY', 'accepted', true],
    ['ready', 'accepted', true],
    ['Ready', 'ACCEPTED', true],
    ['COMPLETED', 'accepted', true],
    ['completed', 'accepted', true],
    ['Completed', 'ACCEPTED', true],

    // Invalid assignment status (must be 'accepted')
    ['READY', 'pending', false],
    ['READY', 'dispatched', false],
    ['READY', 'delivered', false],
    ['READY', 'returned', false],
    ['READY', '', false],
    ['READY', null, false],
    ['READY', undefined, false],

    // Invalid order status
    ['PREPARING', 'accepted', false],
    ['PENDING', 'accepted', false],
    ['CANCELLED', 'accepted', false],
    ['SCHEDULED', 'accepted', false],
    ['UNKNOWN', 'accepted', false],
    ['', 'accepted', false],
    [null, 'accepted', false],
    [undefined, 'accepted', false],

    // Both invalid
    ['PENDING', 'pending', false],
    ['CANCELLED', 'pending', false],
    [null, null, false],
    [undefined, undefined, false],
  ];

  it.each(cases)(
    'canDispatch(orderStatus=%j, assignmentStatus=%j) -> %j',
    (orderStatus, assignmentStatus, expected) => {
      expect(canDispatch(orderStatus, assignmentStatus)).toBe(expected);
    }
  );
});

describe('RIDER_TRANSITIONS', () => {
  it('defines the 4 expected transitions', () => {
    expect(RIDER_TRANSITIONS).toEqual({
      pending: ['accepted'],
      accepted: ['dispatched'],
      dispatched: ['delivered', 'returned'],
    });
  });
});

describe('isRiderTransitionAllowed', () => {
  const cases: [
    from: string | null | undefined,
    to: string | null | undefined,
    expected: boolean
  ][] = [
    // Allowed transitions
    ['pending', 'accepted', true],
    ['PENDING', 'ACCEPTED', true],
    ['Pending', 'Accepted', true],
    ['accepted', 'dispatched', true],
    ['ACCEPTED', 'DISPATCHED', true],
    ['dispatched', 'delivered', true],
    ['DISPATCHED', 'DELIVERED', true],
    ['dispatched', 'returned', true],
    ['DISPATCHED', 'RETURNED', true],

    // Disallowed skips / backwards / invalid
    ['pending', 'dispatched', false],
    ['pending', 'delivered', false],
    ['pending', 'returned', false],
    ['pending', 'pending', false],
    ['accepted', 'pending', false],
    ['accepted', 'delivered', false],
    ['accepted', 'returned', false],
    ['accepted', 'accepted', false],
    ['dispatched', 'pending', false],
    ['dispatched', 'accepted', false],
    ['dispatched', 'dispatched', false],
    ['delivered', 'pending', false],
    ['delivered', 'accepted', false],
    ['delivered', 'dispatched', false],
    ['delivered', 'returned', false],
    ['delivered', 'delivered', false],
    ['returned', 'pending', false],
    ['returned', 'accepted', false],
    ['returned', 'dispatched', false],
    ['returned', 'delivered', false],
    ['returned', 'returned', false],

    // Unknown or nil
    ['unknown', 'accepted', false],
    ['pending', 'unknown', false],
    ['', 'accepted', false],
    ['pending', '', false],
    [null, 'accepted', false],
    ['pending', null, false],
    [undefined, 'accepted', false],
    ['pending', undefined, false],
    [null, null, false],
    [undefined, undefined, false],
  ];

  it.each(cases)(
    'isRiderTransitionAllowed(from=%j, to=%j) -> %j',
    (from, to, expected) => {
      expect(isRiderTransitionAllowed(from, to)).toBe(expected);
    }
  );
});
