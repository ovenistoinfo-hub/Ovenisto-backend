import { describe, it, expect } from 'vitest';
import type { Request } from 'express';
import { checkSupplierAccess } from '../supplier.controller.js';
import { ApiError } from '../../../utils/ApiError.js';

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

describe('checkSupplierAccess', () => {
  it('Super Admin can access supplier with outletId null', () => {
    const req = mockReq({ role: 'Super Admin' });
    expect(() => checkSupplierAccess(req, null)).not.toThrow();
  });

  it('Super Admin cannot access supplier with non-null outletId', () => {
    const req = mockReq({ role: 'Super Admin' });
    expect(() => checkSupplierAccess(req, 'o1')).toThrow(ApiError);
    expect(() => checkSupplierAccess(req, 'o1')).toThrow('Supplier not found');
  });

  it('Branch Manager with outlet o1 can access supplier with outletId o1', () => {
    const req = mockReq({ role: 'Manager', userOutletId: 'o1' });
    expect(() => checkSupplierAccess(req, 'o1')).not.toThrow();
  });

  it('Branch Manager with outlet o1 cannot access supplier with outletId o2', () => {
    const req = mockReq({ role: 'Manager', userOutletId: 'o1' });
    expect(() => checkSupplierAccess(req, 'o2')).toThrow(ApiError);
    expect(() => checkSupplierAccess(req, 'o2')).toThrow('Supplier not found');
  });

  it('Branch Manager with outlet o1 cannot access supplier with outletId null', () => {
    const req = mockReq({ role: 'Manager', userOutletId: 'o1' });
    expect(() => checkSupplierAccess(req, null)).toThrow(ApiError);
    expect(() => checkSupplierAccess(req, null)).toThrow('Supplier not found');
  });

  it('Branch Manager with no outlet assigned cannot access any supplier', () => {
    const req = mockReq({ role: 'Manager', userOutletId: null });
    expect(() => checkSupplierAccess(req, 'o1')).toThrow(ApiError);
    expect(() => checkSupplierAccess(req, null)).toThrow(ApiError);
  });
});
