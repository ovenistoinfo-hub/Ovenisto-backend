/**
 * Warehouse access rules.
 *
 * Two DIFFERENT rules live here — don't conflate them:
 *
 * 1. `canReadWarehouse` — the general by-id read rule, mirroring what
 *    `getWarehouses` already returns: your own outlet's warehouses, plus MAIN
 *    (MAIN stays readable so a branch can see the central store as a supply
 *    source in the demand/challan flow).
 *
 * 2. `resolveDashboardScope` — the STRICTER Warehouse Management dashboard
 *    rule. The dashboard exposes chain financials (inventory value, payables,
 *    the receivable ledger), so it is narrower:
 *
 *      Super Admin     → every warehouse (honours the X-Outlet-Id header)
 *      Admin, Manager  → own outlet: BRANCH + KITCHEN
 *      Store Manager   → own outlet: BRANCH only
 *      Kitchen Manager → own outlet: KITCHEN only
 *
 *    MAIN is Super-Admin-only here, and so is the "Receivable / due to Main"
 *    ledger.
 */

import { ApiError } from '../../utils/ApiError.js';

/** Prisma returns enum MEMBER names, not the @map'd db strings. */
export type WarehouseTypeName = 'MAIN' | 'BRANCH' | 'KITCHEN';

/** Roles allowed to open the Warehouse Management dashboard at all. */
export const WAREHOUSE_DASHBOARD_ROLES = [
  'Super Admin',
  'Admin',
  'Manager',
  'Store Manager',
  'Kitchen Manager',
];

/**
 * Warehouse types each dashboard role may see. Super Admin is deliberately
 * absent — it is unrestricted (all types, including MAIN).
 */
const DASHBOARD_ROLE_TYPES: Record<string, WarehouseTypeName[]> = {
  Admin: ['BRANCH', 'KITCHEN'],
  Manager: ['BRANCH', 'KITCHEN'],
  'Store Manager': ['BRANCH'],
  'Kitchen Manager': ['KITCHEN'],
};

export interface DashboardScope {
  /** Prisma `where` selecting exactly the warehouses this caller may see. */
  where: Record<string, unknown>;
  /** Outlet the caller is pinned to. null only for Super Admin on "All Outlets". */
  outletId: string | null;
  isSuperAdmin: boolean;
  /** True only for a Super Admin on "All Outlets" — nothing needs filtering. */
  unrestricted: boolean;
}

/**
 * Builds the dashboard warehouse filter for a caller.
 *
 * `scopedOutletId` must be the result of `resolveOutletScope(req)`: for a Super
 * Admin that is the X-Outlet-Id header (null = All Outlets); for every other
 * role it is their own `user.outletId`, which the client cannot override.
 *
 * Fails CLOSED: a non-super-admin with no outlet assigned gets 403 rather than
 * falling through to a null scope, which would have meant "see every outlet".
 */
export function resolveDashboardScope(
  role: string | undefined,
  scopedOutletId: string | null
): DashboardScope {
  if (!role || !WAREHOUSE_DASHBOARD_ROLES.includes(role)) {
    throw ApiError.forbidden('You do not have access to the warehouse dashboard');
  }

  if (role === 'Super Admin') {
    if (scopedOutletId === 'none') {
      return {
        where: { isActive: true, type: 'MAIN' },
        outletId: 'none',
        isSuperAdmin: true,
        unrestricted: false,
      };
    }
    return {
      where: { isActive: true, ...(scopedOutletId ? { outletId: scopedOutletId } : {}) },
      outletId: scopedOutletId,
      isSuperAdmin: true,
      unrestricted: scopedOutletId === null,
    };
  }

  if (!scopedOutletId) {
    throw ApiError.forbidden('Your account is not assigned to an outlet');
  }

  return {
    where: {
      isActive: true,
      outletId: scopedOutletId,
      type: { in: DASHBOARD_ROLE_TYPES[role] },
    },
    outletId: scopedOutletId,
    isSuperAdmin: false,
    unrestricted: false,
  };
}

/**
 * General by-id read rule for a single warehouse — mirrors `getWarehouses`, so
 * anything the list shows you, you can also open.
 *
 * Super Admin: anything. Everyone else: their own outlet's warehouses, plus
 * MAIN (needed as a supply source in demands/challans).
 */
export function canReadWarehouse(
  role: string | undefined,
  userOutletId: string | null | undefined,
  warehouse: { type: string; outletId: string | null }
): boolean {
  if (role === 'Super Admin') return true;
  if (warehouse.type === 'MAIN') return true;
  return Boolean(userOutletId) && warehouse.outletId === userOutletId;
}

/**
 * Visibility gate for rows whose warehouse link is NULLABLE (Purchase, WasteRecord).
 *
 * A plain `warehouseId IN (...)` would silently drop rows that have no
 * warehouse but do belong to the outlet (e.g. a purchase booked without one) —
 * so those are added back via their own outletId.
 *
 * Returns `undefined` when no filtering is needed (Super Admin, All Outlets).
 */
export function nullableWarehouseGate(
  scope: DashboardScope,
  visibleIds: string[],
  selectedId: string | null
): Record<string, unknown> | undefined {
  // A specific warehouse is selected: that warehouse's rows only. A row with no
  // warehouse is not "in" any warehouse, so excluding it is correct.
  if (selectedId) return { warehouseId: selectedId };
  if (scope.unrestricted) return undefined;

  const or: Record<string, unknown>[] = [{ warehouseId: { in: visibleIds } }];
  if (scope.outletId) or.push({ warehouseId: null, outletId: scope.outletId });
  return { OR: or };
}

/**
 * Visibility gate for rows with TWO warehouse endpoints (StockDemand,
 * StockChallan). Strict-endpoint — the same convention the outlet-scoping
 * rollout uses: the row is visible if EITHER endpoint is a warehouse you can see.
 *
 * When one warehouse is selected, `selectedField` preserves the existing metric
 * semantics (demands key on supplyingWHId, challans on fromWarehouseId).
 *
 * Returns `undefined` when no filtering is needed.
 */
export function twoEndpointGate(
  scope: DashboardScope,
  visibleIds: string[],
  selectedId: string | null,
  selectedField: string,
  otherField: string
): Record<string, unknown> | undefined {
  if (selectedId) return { [selectedField]: selectedId };
  if (scope.unrestricted) return undefined;
  return {
    OR: [{ [selectedField]: { in: visibleIds } }, { [otherField]: { in: visibleIds } }],
  };
}

/**
 * Returns Prisma where filters for StockDemand based on user's role and outlet scope.
 */
export function getDemandScopeFilter(role: string | undefined, scope: string | null): Record<string, any> {
  if (role === 'Super Admin') {
    return {
      requestingWH: { type: 'BRANCH', ...(scope ? { outletId: scope } : {}) },
      supplyingWH: { type: 'MAIN' },
    };
  }

  if (!scope) {
    throw ApiError.forbidden('Your account is not assigned to an outlet');
  }

  if (role === 'Store Manager') {
    return {
      OR: [
        { requestingWH: { type: 'BRANCH', outletId: scope } },
        { supplyingWH: { type: 'BRANCH', outletId: scope } },
      ],
    };
  }

  if (role === 'Kitchen Manager') {
    return {
      OR: [
        { requestingWH: { type: 'KITCHEN', outletId: scope } },
        { supplyingWH: { type: 'KITCHEN', outletId: scope } },
      ],
    };
  }

  // Admin / Manager / other scoped role
  return {
    OR: [
      { requestingWH: { outletId: scope } },
      { supplyingWH: { outletId: scope } },
    ],
  };
}

/**
 * Returns Prisma where filters for StockChallan based on user's role and outlet scope.
 */
export function getChallanScopeFilter(role: string | undefined, scope: string | null): Record<string, any> {
  if (role === 'Super Admin') {
    return {
      fromWarehouse: { type: 'MAIN' },
      toWarehouse: { type: 'BRANCH', ...(scope ? { outletId: scope } : {}) },
    };
  }

  if (!scope) {
    throw ApiError.forbidden('Your account is not assigned to an outlet');
  }

  if (role === 'Store Manager') {
    return {
      OR: [
        { fromWarehouse: { type: 'BRANCH', outletId: scope } },
        { toWarehouse: { type: 'BRANCH', outletId: scope } },
      ],
    };
  }

  if (role === 'Kitchen Manager') {
    return {
      OR: [
        { fromWarehouse: { type: 'KITCHEN', outletId: scope } },
        { toWarehouse: { type: 'KITCHEN', outletId: scope } },
      ],
    };
  }

  // Admin / Manager / other scoped role
  return {
    OR: [
      { fromWarehouse: { outletId: scope } },
      { toWarehouse: { outletId: scope } },
    ],
  };
}

