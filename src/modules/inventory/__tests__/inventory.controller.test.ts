import { describe, it, expect } from 'vitest';
import type { Request } from 'express';
import { checkIngredientAccess } from '../inventory.controller.js';
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

describe('checkIngredientAccess', () => {
  it('Super Admin can access ingredient with outletId null', () => {
    const req = mockReq({ role: 'Super Admin' });
    expect(() => checkIngredientAccess(req, null)).not.toThrow();
  });

  it('Super Admin cannot access ingredient with non-null outletId', () => {
    const req = mockReq({ role: 'Super Admin' });
    expect(() => checkIngredientAccess(req, 'o1')).toThrow(ApiError);
    expect(() => checkIngredientAccess(req, 'o1')).toThrow('Ingredient not found');
  });

  it('Branch Manager with outlet o1 can access ingredient with outletId o1', () => {
    const req = mockReq({ role: 'Manager', userOutletId: 'o1' });
    expect(() => checkIngredientAccess(req, 'o1')).not.toThrow();
  });

  it('Branch Manager with outlet o1 cannot access ingredient with outletId o2', () => {
    const req = mockReq({ role: 'Manager', userOutletId: 'o1' });
    expect(() => checkIngredientAccess(req, 'o2')).toThrow(ApiError);
    expect(() => checkIngredientAccess(req, 'o2')).toThrow('Ingredient not found');
  });

  it('Branch Manager with outlet o1 cannot access ingredient with outletId null', () => {
    const req = mockReq({ role: 'Manager', userOutletId: 'o1' });
    expect(() => checkIngredientAccess(req, null)).toThrow(ApiError);
    expect(() => checkIngredientAccess(req, null)).toThrow('Ingredient not found');
  });

  it('Branch Manager with no outlet assigned cannot access any ingredient', () => {
    const req = mockReq({ role: 'Manager', userOutletId: null });
    expect(() => checkIngredientAccess(req, 'o1')).toThrow(ApiError);
    expect(() => checkIngredientAccess(req, null)).toThrow(ApiError);
  });
});
