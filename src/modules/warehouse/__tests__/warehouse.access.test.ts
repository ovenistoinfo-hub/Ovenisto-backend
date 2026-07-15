import { describe, it, expect } from 'vitest';
import {
  resolveDashboardScope,
  canReadWarehouse,
  nullableWarehouseGate,
  twoEndpointGate,
  WAREHOUSE_DASHBOARD_ROLES,
  getDemandScopeFilter,
  getChallanScopeFilter,
} from '../warehouse.access.js';

describe('WAREHOUSE_DASHBOARD_ROLES', () => {
  it('is exactly the five permitted roles', () => {
    expect([...WAREHOUSE_DASHBOARD_ROLES].sort()).toEqual([
      'Admin',
      'Kitchen Manager',
      'Manager',
      'Store Manager',
      'Super Admin',
    ]);
  });
});

describe('resolveDashboardScope', () => {
  it('Super Admin on "All Outlets" → every active warehouse, unrestricted', () => {
    const scope = resolveDashboardScope('Super Admin', null);
    expect(scope.where).toEqual({ isActive: true });
    expect(scope.unrestricted).toBe(true);
    expect(scope.isSuperAdmin).toBe(true);
  });

  it('Super Admin with an outlet selected → that outlet only, and no longer unrestricted', () => {
    const scope = resolveDashboardScope('Super Admin', 'o1');
    expect(scope.where).toEqual({ isActive: true, outletId: 'o1' });
    expect(scope.unrestricted).toBe(false);
  });

  it('Admin → own outlet, BRANCH + KITCHEN', () => {
    expect(resolveDashboardScope('Admin', 'o1').where).toEqual({
      isActive: true,
      outletId: 'o1',
      type: { in: ['BRANCH', 'KITCHEN'] },
    });
  });

  it('Manager → own outlet, BRANCH + KITCHEN', () => {
    expect(resolveDashboardScope('Manager', 'o1').where).toEqual({
      isActive: true,
      outletId: 'o1',
      type: { in: ['BRANCH', 'KITCHEN'] },
    });
  });

  it('Store Manager → own outlet, BRANCH only', () => {
    expect(resolveDashboardScope('Store Manager', 'o1').where).toEqual({
      isActive: true,
      outletId: 'o1',
      type: { in: ['BRANCH'] },
    });
  });

  it('Kitchen Manager → own outlet, KITCHEN only', () => {
    expect(resolveDashboardScope('Kitchen Manager', 'o1').where).toEqual({
      isActive: true,
      outletId: 'o1',
      type: { in: ['KITCHEN'] },
    });
  });

  // MAIN carries outletId = null by invariant, so pinning an outletId excludes it.
  it('no non-super-admin scope can reach MAIN (they all pin an outletId)', () => {
    for (const role of ['Admin', 'Manager', 'Store Manager', 'Kitchen Manager']) {
      const where = resolveDashboardScope(role, 'o1').where as { outletId?: string };
      expect(where.outletId).toBe('o1');
    }
  });

  it('a role outside the five is rejected (defence in depth behind authorize())', () => {
    expect(() => resolveDashboardScope('Cashier', 'o1')).toThrow();
    expect(() => resolveDashboardScope('Rider', 'o1')).toThrow();
    expect(() => resolveDashboardScope(undefined, 'o1')).toThrow();
  });

  it('fails CLOSED: a permitted role with no outlet is rejected, not handed every outlet', () => {
    expect(() => resolveDashboardScope('Manager', null)).toThrow();
    expect(() => resolveDashboardScope('Store Manager', null)).toThrow();
  });
});

describe('canReadWarehouse', () => {
  const branchO1 = { type: 'BRANCH', outletId: 'o1' };
  const branchO2 = { type: 'BRANCH', outletId: 'o2' };
  const main = { type: 'MAIN', outletId: null };

  it('Super Admin reads anything', () => {
    expect(canReadWarehouse('Super Admin', null, branchO2)).toBe(true);
  });

  it('a user reads their own outlet, not another outlet', () => {
    expect(canReadWarehouse('Manager', 'o1', branchO1)).toBe(true);
    expect(canReadWarehouse('Manager', 'o1', branchO2)).toBe(false);
  });

  it('MAIN stays readable to everyone — it is the supply source for demands/challans', () => {
    expect(canReadWarehouse('Kitchen Manager', 'o1', main)).toBe(true);
  });

  it('a user with no outlet cannot read an outlet-owned warehouse', () => {
    expect(canReadWarehouse('Manager', null, branchO1)).toBe(false);
  });
});

describe('nullableWarehouseGate', () => {
  const saAll = resolveDashboardScope('Super Admin', null);
  const mgr = resolveDashboardScope('Manager', 'o1');

  it('Super Admin on All Outlets, no selection → no filter at all', () => {
    expect(nullableWarehouseGate(saAll, ['w1'], null)).toBeUndefined();
  });

  it('keeps rows that have NO warehouse but do belong to the outlet', () => {
    expect(nullableWarehouseGate(mgr, ['w1', 'w2'], null)).toEqual({
      OR: [{ warehouseId: { in: ['w1', 'w2'] } }, { warehouseId: null, outletId: 'o1' }],
    });
  });

  it('a specific warehouse selected → that warehouse only, even for a Super Admin', () => {
    expect(nullableWarehouseGate(saAll, ['w1', 'w2'], 'w1')).toEqual({ warehouseId: 'w1' });
    expect(nullableWarehouseGate(mgr, ['w1', 'w2'], 'w1')).toEqual({ warehouseId: 'w1' });
  });

  it('an empty visible set matches nothing rather than everything', () => {
    const gate = nullableWarehouseGate(mgr, [], null) as { OR: unknown[] };
    expect(gate.OR[0]).toEqual({ warehouseId: { in: [] } });
  });
});

describe('twoEndpointGate', () => {
  const saAll = resolveDashboardScope('Super Admin', null);
  const km = resolveDashboardScope('Kitchen Manager', 'o1');

  it('Super Admin on All Outlets, no selection → no filter', () => {
    expect(twoEndpointGate(saAll, ['w1'], null, 'fromWarehouseId', 'toWarehouseId')).toBeUndefined();
  });

  it('no selection → visible if EITHER endpoint is ours, so inbound transfers still count', () => {
    expect(twoEndpointGate(km, ['w1'], null, 'fromWarehouseId', 'toWarehouseId')).toEqual({
      OR: [{ fromWarehouseId: { in: ['w1'] } }, { toWarehouseId: { in: ['w1'] } }],
    });
  });

  it('a selection keeps the original single-endpoint metric semantics', () => {
    expect(twoEndpointGate(km, ['w1'], 'w1', 'supplyingWHId', 'requestingWHId')).toEqual({
      supplyingWHId: 'w1',
    });
  });
});

describe('getDemandScopeFilter', () => {
  it('Super Admin with All Outlets → BRANCH to MAIN', () => {
    expect(getDemandScopeFilter('Super Admin', null)).toEqual({
      requestingWH: { type: 'BRANCH' },
      supplyingWH: { type: 'MAIN' },
    });
  });

  it('Super Admin with specific Outlet → BRANCH in that outlet to MAIN', () => {
    expect(getDemandScopeFilter('Super Admin', 'o1')).toEqual({
      requestingWH: { type: 'BRANCH', outletId: 'o1' },
      supplyingWH: { type: 'MAIN' },
    });
  });

  it('Store Manager → BRANCH in their outlet', () => {
    expect(getDemandScopeFilter('Store Manager', 'o1')).toEqual({
      OR: [
        { requestingWH: { type: 'BRANCH', outletId: 'o1' } },
        { supplyingWH: { type: 'BRANCH', outletId: 'o1' } },
      ],
    });
  });

  it('Kitchen Manager → KITCHEN in their outlet', () => {
    expect(getDemandScopeFilter('Kitchen Manager', 'o1')).toEqual({
      OR: [
        { requestingWH: { type: 'KITCHEN', outletId: 'o1' } },
        { supplyingWH: { type: 'KITCHEN', outletId: 'o1' } },
      ],
    });
  });

  it('Admin / Manager → any warehouse in their outlet', () => {
    expect(getDemandScopeFilter('Admin', 'o1')).toEqual({
      OR: [
        { requestingWH: { outletId: 'o1' } },
        { supplyingWH: { outletId: 'o1' } },
      ],
    });
  });
});

describe('getChallanScopeFilter', () => {
  it('Super Admin with All Outlets → MAIN to BRANCH', () => {
    expect(getChallanScopeFilter('Super Admin', null)).toEqual({
      fromWarehouse: { type: 'MAIN' },
      toWarehouse: { type: 'BRANCH' },
    });
  });

  it('Super Admin with specific Outlet → MAIN to BRANCH in that outlet', () => {
    expect(getChallanScopeFilter('Super Admin', 'o1')).toEqual({
      fromWarehouse: { type: 'MAIN' },
      toWarehouse: { type: 'BRANCH', outletId: 'o1' },
    });
  });

  it('Store Manager → BRANCH in their outlet', () => {
    expect(getChallanScopeFilter('Store Manager', 'o1')).toEqual({
      OR: [
        { fromWarehouse: { type: 'BRANCH', outletId: 'o1' } },
        { toWarehouse: { type: 'BRANCH', outletId: 'o1' } },
      ],
    });
  });

  it('Kitchen Manager → KITCHEN in their outlet', () => {
    expect(getChallanScopeFilter('Kitchen Manager', 'o1')).toEqual({
      OR: [
        { fromWarehouse: { type: 'KITCHEN', outletId: 'o1' } },
        { toWarehouse: { type: 'KITCHEN', outletId: 'o1' } },
      ],
    });
  });
});

