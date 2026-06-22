# Phase B4b — Outlet Scoping: StockChallan + StockDemand (Inter-Warehouse Transfers)

**Date:** 2026-06-22
**Status:** Approved design
**Depends on:** Phase A (`resolveOutletScope`, `X-Outlet-Id` header), B4a (Purchases). Sibling of B4a — together they complete B4 (Procurement).

---

## 1. Goal

Outlet-scope the two-warehouse inter-warehouse transfer flow:
- **StockChallan** — a physical stock transfer between two warehouses (PENDING → DISPATCHED → RECEIVED, or CANCELLED).
- **StockDemand** — a request for stock that, on approval, auto-creates a challan.

Backend-only. After this, a non-admin user sees/acts only on transfers touching their outlet; a Super Admin sees everything on "All Outlets" and a single outlet's transfers when one is selected in the global header.

## 2. Non-Goals / Why This Is Simpler Than B4a

- **No schema change. No backfill.** Both entities span *two* warehouses, so a single denormalized `outletId` column is neither possible nor meaningful. Outlet is **derived** from the warehouse relations at query time.
- **No frontend change.** Phase A already sends `X-Outlet-Id` via `api.ts`; the Transfers page reads scoped lists transparently.
- No change to the transfer **workflow** (status machine, stock math, type rules like `BRANCH → KITCHEN`). Only **visibility + access scoping** is added.

## 3. Scoping Model — Strict-Endpoint, Unified via `resolveOutletScope`

A row is **in scope** for an outlet if **either** of its two warehouses belongs to that outlet.

```ts
const scope = resolveOutletScope(req);   // Super Admin → header outlet or null('All'); else user.outletId
if (scope) {
  where.OR = [
    { fromWarehouse: { outletId: scope } },   // demand: requestingWH / supplyingWH
    { toWarehouse:   { outletId: scope } },
  ];
}
```

Consequences (intended):
- A branch sees its transfers **with the central MAIN warehouse** (its own warehouse is always one endpoint).
- A branch does **not** see `MAIN ↔ other-branch` transfers (neither endpoint is theirs).
- Super Admin on "All" (`scope === null`) → no filter → sees everything.

This **unifies** the two modules, which today scope inconsistently:
- Challan: `getUserScopeWhIds(outletId)` (strict-endpoint, but via a helper that issues an extra query).
- Demand: `OR [{outletId}, {type:'MAIN'}]` (MAIN-inclusive — broader) **plus** a Super-Admin special case that shows only `BRANCH → MAIN` demands.

Both are replaced by the single rule above. The Super-Admin demand special case is **removed**: SA on "All" sees all demands (both `BRANCH → MAIN` and `KITCHEN → BRANCH`); SA on an outlet sees that outlet's.

**Data precondition (verified 2026-06-22):** every BRANCH and KITCHEN warehouse has a non-null `outletId` (0 violations); only the central `Main Warehouse` (type `main`) is null. So derivation is safe — no fail-safe-invisible rows.

## 4. Files & Changes

Both controllers use the `new ApiError('message', statusCode)` constructor style — match it. All routes in both modules already carry `authenticate` (route-auth audit passed; the B2 silent-null risk does not apply here).

### 4.1 `src/modules/challans/challan.controller.ts`

Handlers: `getChallans`, `getChallan`, `createChallan`, `dispatchChallan`, `receiveChallan`, `cancelChallan`. Relation fields: `fromWarehouse` / `toWarehouse` (schema relations `ChallanFrom` / `ChallanTo`).

- **`getChallans`** — delete the `ADMIN_ROLES.includes(...)` + `getUserScopeWhIds(req.user?.outletId)` block; replace with the unified `resolveOutletScope` OR-filter (§3). Delete the now-unused `getUserScopeWhIds` helper and the `ADMIN_ROLES` const (confirm no other use in the file first).
- **By-id outlet guard** on `getChallan`, `dispatchChallan`, `receiveChallan`, `cancelChallan`: after the not-found check and **before** any stock-mutating `$transaction`, if `scope` is set and neither `fromWarehouse.outletId` nor `toWarehouse.outletId` equals `scope`, throw `new ApiError('Challan not found', 404)`. The handler's load must `select`/`include` both warehouses' `outletId` (extend the existing load).
  - `receiveChallan` currently has a partial check ("You can only receive challans destined to your outlet", 403). **Replace** it with the unified guard so SA-on-an-outlet and branch staff are handled by one rule. (The separate "Super Admin cannot receive challans" 403 rule is a workflow rule and stays.)
- **`createChallan`** — already validates warehouse types and "Branch can only transfer to its own outlet's kitchen". Add: if `scope` is set and `fromWarehouse.outletId !== scope`, throw `new ApiError('From warehouse is not in your outlet', 403)`. (Main-warehouse staff have no `outletId` → `scope` is null → no restriction, preserving `MAIN → branch` dispatch creation.)

### 4.2 `src/modules/demands/demand.controller.ts`

Handlers: `getDemands`, `getDemand`, `createDemand`, `approveDemand`, `rejectDemand`, `cancelDemand`. Relation fields: `requestingWH` / `supplyingWH`.

- **`getDemands`** — delete the `req.user?.role === 'Super Admin'` special case and the non-admin `OR [{outletId},{type:'MAIN'}]` block; replace with the unified OR-filter over `requestingWH` / `supplyingWH` (§3).
- **By-id outlet guard** on `getDemand`, `approveDemand`, `rejectDemand`, `cancelDemand`: after not-found and **before** the mutation (and, for `approveDemand`, before it auto-creates the challan), if `scope` is set and neither `requestingWH.outletId` nor `supplyingWH.outletId` equals `scope`, throw `new ApiError('Demand not found', 404)`. Loads must include both warehouses' `outletId`.
  - **Keep** the existing approval-authority role gates (`BRANCH → MAIN` requires Super Admin; `KITCHEN → BRANCH` blocks Super Admin). These are orthogonal workflow rules; the outlet guard is *additional*, not a replacement.
- **`createDemand`** — if `scope` is set, require `requestingWH.outletId === scope` (a branch may only raise a demand for its own warehouse); else throw `new ApiError('Requesting warehouse is not in your outlet', 403)`. The `supplyingWH` may be MAIN — that is fine under strict-endpoint.

## 5. Error Handling

- Cross-outlet by-id access → `404 'Challan not found'` / `'Demand not found'` (do not leak existence — mirror B4a's by-id guards).
- Cross-outlet create → `403` with a specific message ("…is not in your outlet").
- Existing status-machine and type-rule errors are unchanged.

## 6. Verification

**The backend has no test runner configured** (vitest is frontend-only). As in every prior outlet-scoping sub-phase, verification is `npm run typecheck` (must pass clean) + `npm run build` + live API checks against prod. Do **not** author backend `.test.ts` files — there is no runner to execute them.

**Live (prod, read-mostly):**
- `GET /challans` and `GET /demands` totals differ across `X-Outlet-Id: all` vs Main vs DHA.
- Cross-outlet by-id `GET /challans/:id` (a Main challan fetched as DHA) → 404; own → 200. Same for demands.
- `PATCH /challans/:id/dispatch|cancel` and `/demands/:id/approve|reject` cross-outlet → 404 (guard fires before mutation; no state change).
- Super Admin on "All" sees both demand directions (`BRANCH → MAIN` and `KITCHEN → BRANCH`).
- A legitimate flow still works end-to-end: branch creates demand → approver approves (challan auto-created) → dispatch → receive.

## 7. Out of Scope / Follow-ups

- **B5 (Delivery):** `DeliveryRider`, `DeliveryAssignment` — last outlet-scoping sub-phase.
- Deferred from B1: `createTransfer` body-outlet forge guard.
- `Customer` / `Supplier` remain chain-wide by design.
