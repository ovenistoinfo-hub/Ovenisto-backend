import { describe, it, expect } from 'vitest';
import type { Request } from 'express';
import { resolveOutletScope } from '../outletScope.js';

function mockReq(opts: {
  role?: string;
  userOutletId?: string | null;
  headerOutlet?: string;
  queryOutlet?: string;
}): Request {
  return {
    headers: opts.headerOutlet !== undefined ? { 'x-outlet-id': opts.headerOutlet } : {},
    query: opts.queryOutlet !== undefined ? { outletId: opts.queryOutlet } : {},
    user: opts.role !== undefined ? { id: 'u1', role: opts.role, outletId: opts.userOutletId ?? null } : undefined,
  } as unknown as Request;
}

describe('resolveOutletScope', () => {
  it('Super Admin with no header → null (see everything)', () => {
    expect(resolveOutletScope(mockReq({ role: 'Super Admin' }))).toBeNull();
  });

  it('Super Admin with header "all" → null', () => {
    expect(resolveOutletScope(mockReq({ role: 'Super Admin', headerOutlet: 'all' }))).toBeNull();
  });

  it('Super Admin with header "o1" → "o1"', () => {
    expect(resolveOutletScope(mockReq({ role: 'Super Admin', headerOutlet: 'o1' }))).toBe('o1');
  });

  it('Manager is forced to own outlet, ignoring a foreign header', () => {
    expect(resolveOutletScope(mockReq({ role: 'Manager', userOutletId: 'o1', headerOutlet: 'o2' }))).toBe('o1');
  });

  it('Manager with no header → own outlet', () => {
    expect(resolveOutletScope(mockReq({ role: 'Manager', userOutletId: 'o1' }))).toBe('o1');
  });

  it('Manager with no assigned outlet → null (documented edge)', () => {
    expect(resolveOutletScope(mockReq({ role: 'Manager', userOutletId: null }))).toBeNull();
  });

  it('falls back to the query param when no header is present (Super Admin)', () => {
    expect(resolveOutletScope(mockReq({ role: 'Super Admin', queryOutlet: 'o3' }))).toBe('o3');
  });

  it('no user on request → null', () => {
    expect(resolveOutletScope(mockReq({}))).toBeNull();
  });
});
