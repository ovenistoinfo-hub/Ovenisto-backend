# Outlet Scoping — Phase A (Foundation) — Design Spec

**Date:** 2026-06-20
**Status:** Approved (design); pending spec review → writing-plans
**Author:** Brainstorm session (Hamza + Claude)

---

## Problem

The Ovenisto POS is **not outlet-scoped**. There is no global "active outlet"
concept: a user sees and operates on data across all branches indiscriminately.
The client wants every operation scoped to a specific outlet, with role-based
visibility:

- **Super Admin** can pick **any** outlet (or "All Outlets" to view everything),
  and any operation they perform belongs to the **selected** outlet.
- **Everyone else** (Admin, Manager, Cashier, …) is **locked to their own linked
  outlet** (`user.outletId`) — they only ever see and act on that branch.
- The Dashboard already supports per-outlet viewing (Super Admin all/one); this
  generalizes that behaviour to the whole app, surfaced via a **header selector**.

### Why this is decomposed (scope reality)

Only **4 models** currently carry `outletId`: `User`, `Settings`, `Warehouse`,
`Order` (and `LoyaltySettings`, unused). The ~15 core transactional models —
`Customer`, `Expense`, `StockAdjustment`, `StockTake`, `Production`,
`WasteRecord`, `Transfer`, `Shift`, `Supplier`, `Purchase` (note: `Purchase`
also lacks it), `DeliveryAssignment`, `Attendance`, `StockChallan`,
`StockDemand`, etc. — have **no outlet field at all**. Making "every operation
outlet-scoped" real requires adding the column to those models, backfilling,
and filtering ~20 backend modules. That is too large for one spec.

**Decomposition into 3 sequential phases**, each its own spec → plan → build →
deploy, producing working software at each step:

- **Phase A (THIS SPEC) — Foundation.** Global outlet context + header selector
  + role enforcement, applied to the entities that **already** have `outletId`
  (Orders, Warehouses, Dashboard, Reports). Builds the reusable
  `resolveOutletScope` backend helper and the frontend `OutletContext` +
  request plumbing that every later phase consumes.
- **Phase B — Core transactional models.** Add `outletId` to Customer, Expense,
  Stock*, Production, Waste, Shift, etc. + backfill + filter/stamp every
  endpoint via the Phase A helper.
- **Phase C — The rest.** HR/Attendance, Loyalty, Suppliers, Purchases, polish.

---

## Goals (Phase A)

1. A global **OutletContext** holding the active outlet, initialized by role and
   persisted to `localStorage` (survives refresh/navigation).
2. A **header outlet selector**: Super Admin = "All Outlets" + every outlet;
   everyone else = their linked outlet, shown disabled/locked.
3. Backend **enforcement** so a non-super-admin cannot escape their outlet
   (server forces `req.user.outletId`, ignoring any client-sent value).
4. Apply scope to the **already-scopable** endpoints: Orders (list + create),
   Warehouses (list), Dashboard, Reports.
5. **Block create on "All Outlets"** — a write that needs an outlet while scope
   is "all" returns `400 "Select a specific outlet before creating"`.
6. A reusable `resolveOutletScope(req)` helper for Phase B/C.

## Non-Goals (Phase A)

- Adding `outletId` to models that lack it (Phase B/C).
- Filtering Customer, Expense, Stock*, Production, Waste, Shift, Supplier,
  Attendance, Purchase, etc. (those have no column yet).
- Any data migration/backfill (none needed — Phase A only touches existing
  columns).
- Changing how a user is *assigned* to an outlet (admin user-management UI is
  unchanged; `user.outletId` is set as it is today).

---

## Architecture

### Frontend — Global Outlet Context

A new `OutletContext` (wrapping the app like `AuthContext`) exposes:

```ts
interface OutletContextValue {
  selectedOutletId: string;        // "all" or an outlet id
  setSelectedOutletId: (id: string) => void;
  outlets: { id: string; name: string }[];
  isLocked: boolean;               // true for non-super-admin
}
```

Initialization on login / mount:
- **Super Admin** → `localStorage['ovenisto_selected_outlet']` if present, else
  `"all"`. May change to any outlet or back to "all".
- **Everyone else** → forced to `user.outletId` (string). `isLocked = true`;
  the selector renders disabled showing that outlet's name. If a non-admin has
  no `outletId` (data gap), fall back to `"all"` but keep `isLocked = true`
  (they will still be constrained server-side).

Persistence: `setSelectedOutletId` writes to `localStorage`. Logout clears it
(add to the existing logout cleanup that already removes `ovenisto_user`).

A `useOutlet()` hook returns the context value.

### Frontend — Request Plumbing (the key low-touch move)

`src/services/api.ts` has a single `request()` choke-point and an internal GET
cache. Two surgical changes there propagate the outlet to **every** call without
touching the ~20 service files:

1. **A tiny module-level holder** (same file or a small `outletStore.ts`):
   ```ts
   let activeOutletId = 'all';
   export const outletStore = {
     get: () => activeOutletId,
     set: (id: string) => { activeOutletId = id; },
   };
   ```
   `OutletContext` calls `outletStore.set(id)` whenever the selection changes
   (and on init).

2. **Inject the header** in `request()` (both the initial fetch and the
   post-refresh retry):
   ```ts
   'X-Outlet-Id': outletStore.get(),
   ```

3. **Fold the outlet into the GET cache key** so switching outlets doesn't serve
   another outlet's cached rows:
   ```ts
   function getCacheKey(endpoint: string): string {
     return `${outletStore.get()}::${endpoint}`;
   }
   ```
   On outlet change, also call `api.clearCache()` (already exported) so any
   in-memory entries for the previous outlet are dropped immediately.

> react-query pages additionally key their queries by `outletId` (Dashboard
> already does). The cache-key change above covers the `api.ts` layer beneath
> react-query. Both layers must be outlet-aware.

### Frontend — Header Selector

`src/components/layout/AppHeader.tsx` gains an outlet dropdown (shadcn `Select`),
driven by `useOutlet()`:
- Super Admin: options = `[{ id: 'all', name: 'All Outlets' }, ...outlets]`,
  enabled.
- Others: single option = their outlet, `disabled`.
Changing it calls `setSelectedOutletId`, which updates context → `outletStore`
→ clears `api.ts` cache → react-query refetches (its keys include `outletId`).

### Backend — Scope Resolution

`authenticate` already selects and attaches `outletId` to `req.user`
(confirmed: `authenticate.ts` selects `outletId`; the `Express.Request.user`
type includes `outletId?: string | null`). Add a pure helper:

```ts
// src/middleware/outletScope.ts (or src/utils/outletScope.ts)
// Returns the effective outlet filter:
//   null  → no filter (Super Admin viewing "All")
//   <id>  → restrict to this outlet
export function resolveOutletScope(req: Request): string | null {
  const requested = (req.header('X-Outlet-Id') || req.query.outletId) as string | undefined;
  const role = req.user?.role;
  if (role === 'Super Admin') {
    if (!requested || requested === 'all') return null;   // see everything
    return requested;                                      // specific outlet
  }
  // Everyone else: forced to their own outlet, header is ignored.
  return req.user?.outletId ?? null;
}
```

Usage in controllers:
- **Read (list) endpoints:**
  ```ts
  const scope = resolveOutletScope(req);
  where: { ...(scope ? { outletId: scope } : {}) }
  ```
- **Write endpoints that belong to an outlet:**
  ```ts
  const scope = resolveOutletScope(req);
  if (scope === null) throw ApiError.badRequest('Select a specific outlet before creating');
  // ...stamp outletId: scope on create
  ```
  (The `scope === null` block only applies to Super Admin on "All"; non-admins
  always get a concrete `outletId`.)

### Backend — Endpoints wired in Phase A

| Module | Endpoint | Change |
|--------|----------|--------|
| order | `GET /orders` | filter list by `resolveOutletScope` |
| order | `POST /orders` | stamp `outletId: scope`; block if scope null |
| warehouse | `GET /warehouses` | filter list by scope |
| reports | `GET /reports/*`, `/reports/dashboard` | derive `outletId` from `resolveOutletScope` instead of trusting the raw query param (so a non-admin can't pass another outlet's id) |

> Dashboard/Reports already accept an `outletId` query param. Phase A routes
> that param **through** `resolveOutletScope` so it is enforced, not just
> honoured. Behaviour for Super Admin is unchanged (all/any); non-admins are now
> pinned to their own outlet even if the client sends a different id.

---

## Data Flow

```
Login
  └─> OutletContext init (role-based) ─> outletStore.set(id) ─> localStorage

User action (any page)
  api.get/post(endpoint)
    └─> request() adds header  X-Outlet-Id: outletStore.get()
          └─> backend authenticate ─> req.user (role, outletId)
                └─> resolveOutletScope(req) ─> null | outletId
                      ├─ read:  where outletId = scope (or no filter if null)
                      └─ write: stamp outletId = scope (400 if null & required)

Super Admin changes selector  A ─> B
  └─> setSelectedOutletId('B') ─> outletStore.set('B') ─> api.clearCache()
        └─> react-query keys (…, 'B') refetch ─> pages show outlet B
```

---

## Error Handling

- **Create on "All Outlets" (Super Admin):** `400 Bad Request`,
  message `"Select a specific outlet before creating"`. Frontend surfaces it as
  a toast; ideally the create button is disabled / prompts outlet choice when
  `selectedOutletId === 'all'` (nice-to-have; the 400 is the hard guarantee).
- **Non-admin sends a foreign `X-Outlet-Id`:** silently ignored — server forces
  `req.user.outletId`. No error (defense, not a user-facing failure).
- **Non-admin with no `outletId`:** reads return their (null→unfiltered) set as
  today; this is a pre-existing data gap, not introduced here. Flag in Phase B.

---

## Testing

**Backend unit (vitest) — `resolveOutletScope`:**
- Super Admin, no header / `"all"` → `null`.
- Super Admin, header `"o1"` → `"o1"`.
- Manager (role ≠ Super Admin), header `"o2"`, `req.user.outletId = "o1"` → `"o1"` (forced).
- Manager, no header, `outletId = "o1"` → `"o1"`.
- User with no `outletId` → `null` (documented edge).

**Backend behaviour:**
- `GET /orders` as Manager of outlet o1 with header `o2` → only o1 orders.
- `POST /orders` as Super Admin with header `all` → `400`.
- `POST /orders` as Super Admin with header `o1` → order created with `outletId=o1`.

**Frontend (manual browser pass):**
- Super Admin: selector shows All + outlets; switching changes Orders/Dashboard data.
- Manager: selector shows own outlet, disabled; only own-outlet data visible.
- Refresh preserves Super Admin's last-selected outlet.

---

## Files (Phase A)

**Frontend:**
- Create: `src/contexts/OutletContext.tsx`, `src/services/outletStore.ts` (or fold the holder into `api.ts`)
- Modify: `src/services/api.ts` (header inject + cache key), `src/App.tsx` (wrap provider), `src/components/layout/AppHeader.tsx` (selector), `src/contexts/AuthContext.tsx` (logout cleanup of stored outlet)
- Touch (re-query on change is automatic via react-query keys): `Orders`/`OrderStatusBoard`, `Warehouses`, `Dashboard` already key by outletId

**Backend:**
- Create: `src/middleware/outletScope.ts` (+ test `__tests__/outletScope.test.ts`)
- Modify: `src/modules/order/order.controller.ts` (list filter + create stamp/guard), `src/modules/warehouse/*.controller.ts` (list filter), `src/modules/reports/reports.controller.ts` (route param through helper)

---

## Reuse for Phase B/C

`resolveOutletScope` and the frontend `OutletContext` + `outletStore` + header
plumbing are the foundation. Phase B adds `outletId` columns to the transactional
models and applies the same helper to their list/create endpoints — no new
plumbing needed. That is the payoff of doing Phase A first.
