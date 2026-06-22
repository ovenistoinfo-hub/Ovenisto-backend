# Outlet Scoping — Phase B4a (Purchases & Purchase Requests) — Design Spec

**Date:** 2026-06-22
**Status:** Approved (design); pending spec review → writing-plans
**Author:** Brainstorm session (Hamza + Claude)
**Builds on:** Phase A (`resolveOutletScope`, `X-Outlet-Id`), B1 (`resolveCreateOutlet`, the
add-column → backfill → stamp → filter recipe + the dashboard-aggregation scoping), B2/B3 (the by-id
guard pattern + the route-auth lesson). See the prior phase specs.

---

## Problem

Phase B4 outlet-scopes the **Procurement** domain. The exploration (5-agent map) showed it has two
distinct shapes, so B4 is split:

- **B4a (THIS SPEC) — supplier flow:** `Purchase` + `PurchaseRequest` (single-warehouse).
- **B4b (later) — inter-warehouse flow:** `StockChallan` + `StockDemand` (two-warehouse; the
  Transfer pattern; stock-mutating status transitions).

**B4a problem:** `Purchase` has **zero** outlet scoping today — every branch sees and can mutate every
branch's purchases, and a non-super-admin who learns a purchase id can update payment or delete it
(reversing another outlet's stock). `PurchaseRequest` has partial Phase-A-style **list** scoping but its
**by-id read + approve/reject/cancel transitions lack outlet guards** (cross-outlet IDOR on the approval
workflow). And the Dashboard **"payable"** metric is chain-wide.

### Decisions already made (brainstorming)
- **Split B4 → B4a then B4b.** B4a is Purchase + PurchaseRequest.
- **Purchase gets a denormalized `outletId`** column (its `warehouseId` is optional, so the outlet
  can't always be derived). **PurchaseRequest gets NO column** — its `warehouseId` is required and
  always a BRANCH warehouse (which has an outlet), so it derives outlet via the warehouse relation.
- **Backfill:** `Purchase` → warehouse outlet where derivable, else "Ovenisto Main Branch".
- **Dashboard payable** becomes per-outlet (computed from `Purchase.due`). Receivable stays chain-wide
  (Customer is chain-wide).
- Supplier stays chain-wide (one vendor serves all branches; `Supplier.totalDue` is an emergent global
  metric — not scoped).

---

## Goals (B4a)

1. Add nullable `outletId` to `Purchase` (+ Outlet back-relation + index).
2. Purchase: scope `getPurchases`; stamp `createPurchase` (warehouse outlet, else user scope);
   by-id guards on `getPurchase`, `updatePurchase`, `deletePurchase`.
3. PurchaseRequest: migrate `getPurchaseRequests` list scoping to `resolveOutletScope`; add by-id
   guards on `getPurchaseRequest`, `approveRequest`, `rejectRequest`, `cancelRequest`; generalize
   `createPurchaseRequest`'s outlet check to `resolveOutletScope`.
4. Dashboard `payable` becomes per-outlet (from `Purchase.due`).
5. Backfill existing `Purchase` rows.
6. No frontend changes.

## Non-Goals (B4a)

- `StockChallan` / `StockDemand` (B4b).
- A denormalized column on `PurchaseRequest` (derives via warehouse).
- Scoping `Supplier` or `Supplier.totalPurchases`/`totalDue` (chain-wide by design).
- Scoping `WarehouseStock`/`StockBatch` (already derive outlet via warehouse; B1 noted this).
- Changing the receivable metric (Customer chain-wide).

---

## Architecture

### Schema (Neon, `prisma db push` — non-destructive)

`Purchase` — add:
```prisma
  outletId      String?
  outlet        Outlet?  @relation(fields: [outletId], references: [id])
  // + @@index([outletId])
```
`Outlet` — add `purchases Purchase[]` back-relation. `PurchaseRequest`: **no change**.

### Purchase controller (`src/modules/purchases/purchase.controller.ts`)

All five routes already carry `authenticate` (verified in the map). Reuse `resolveOutletScope` /
`resolveCreateOutlet`.

- **`getPurchases`** — `const scope = resolveOutletScope(req); if (scope) where.outletId = scope;`
- **`getPurchase`** (by-id) — after the existing not-found check:
  `const scope = resolveOutletScope(req); if (scope && purchase.outletId !== scope) throw ApiError.notFound('Purchase not found');`
- **`createPurchase`** — derive the warehouse's outlet, then stamp:
  ```ts
  const pWarehouse = warehouseId
    ? await prisma.warehouse.findUnique({ where: { id: warehouseId }, select: { outletId: true } })
    : null;
  const outletId = resolveCreateOutlet(req, pWarehouse?.outletId);   // warehouse outlet, else scope, else 400
  // ...stamp outletId in the purchase create data
  ```
- **`updatePurchase`** (payment) and **`deletePurchase`** (reverses stock) — add the same by-id guard
  immediately after each handler's existing not-found check, BEFORE any mutation/reversal.

### PurchaseRequest controller (`src/modules/purchase-requests/purchase-request.controller.ts`)

`PurchaseRequest` has no `outletId` column; scope is the target **warehouse's** outlet. All routes are
authenticated.

- **`getPurchaseRequests`** — replace the existing inline non-super-admin
  `warehouse: { OR: [{ outletId }, { type: 'MAIN' }] }` block with strict, Super-Admin-aware scoping:
  ```ts
  const scope = resolveOutletScope(req);
  if (scope) where.warehouse = { outletId: scope };
  ```
  (A PurchaseRequest always targets a BRANCH warehouse, so there are no MAIN-warehouse requests — the
  old MAIN clause was inert; this is behaviorally equivalent and adds Super-Admin outlet-switching.)
- **`getPurchaseRequest`** (by-id) — ensure the fetch includes the warehouse's `outletId`, then guard:
  `const scope = resolveOutletScope(req); if (scope && pr.warehouse.outletId !== scope) throw ApiError.notFound('Purchase request not found');`
- **`createPurchaseRequest`** — replace the existing manual "non-super-admin warehouse.outletId ===
  req.user.outletId" check with: `const scope = resolveOutletScope(req); if (scope && warehouse.outletId !== scope) throw ApiError.badRequest('Warehouse is not in your outlet');`
  (Keeps the existing BRANCH-type validation. No 400-on-"All" — a Super Admin on "All" may create for
  any branch warehouse, which determines the outlet.)
- **`approveRequest`** / **`rejectRequest`** / **`cancelRequest`** (by-id status writes) — load the
  request including `warehouse.outletId`, add the same by-id guard after the not-found check and BEFORE
  the status mutation.

### Dashboard payable (`src/modules/reports/reports.controller.ts`, `getDashboard`)

Replace the chain-wide supplier aggregation with a per-outlet `Purchase.due` sum. Today:
```ts
prisma.supplier.aggregate({ _sum: { totalDue: true } }),
// ...
const payable = Math.round(Number(supplierAgg._sum.totalDue ?? 0));
```
Becomes (using the existing `outletFilter` const in `getDashboard`):
```ts
prisma.purchase.aggregate({ where: { ...outletFilter }, _sum: { due: true } }),
// ...
const payable = Math.round(Number(purchaseAgg._sum.due ?? 0));
```
For "All" (Super Admin) this sums every outlet's purchase due — should match the prior supplier total,
slightly more accurate. Receivable (Customer) is unchanged.

### Frontend

No code changes. Purchases and PurchaseRequests pages call their services through `api.ts` (sends
`X-Outlet-Id`, refetches on outlet switch). A Super Admin on "All" creating a no-warehouse purchase
gets the 400 toast (must pick an outlet) — consistent with prior phases.

---

## Data Flow

```
POST /api/purchases           → resolveCreateOutlet(req, warehouse?.outletId) → outletId (or 400) → stamped
GET /api/purchases            → where.outletId = resolveOutletScope(req)
GET/PUT/DELETE /purchases/:id → if (scope && purchase.outletId !== scope) → 404

PurchaseRequest list/by-id/transitions → scope via pr.warehouse.outletId
  list:  where.warehouse = { outletId: scope }
  by-id: if (scope && pr.warehouse.outletId !== scope) → 404

Dashboard payable → sum(Purchase.due) where outletFilter
```

---

## Error Handling

- **Create a no-warehouse purchase on "All" (Super Admin):** `400` — `Select a specific outlet before creating`.
- **Create a PR for a warehouse outside the acting scope:** `400` — `Warehouse is not in your outlet`.
- **By-id cross-outlet (purchase get/update/delete; PR get/approve/reject/cancel):** `404` — exact
  messages `Purchase not found` / `Purchase request not found` (no 403; don't leak existence). Match
  each controller's existing `ApiError` style (`ApiError.notFound(...)` vs `new ApiError(msg, 404)` —
  the plan will specify per file).
- **Non-super-admin with no `outletId`:** `resolveCreateOutlet` throws 400 (purchase create) — the
  documented pre-existing edge.

---

## Backfill / Migration

**Migration:** `Purchase.outletId` nullable column added by `prisma db push` (Railway on boot).
Non-destructive.

**Backfill seed** `src/seeds/outletPurchaseBackfill.ts` (`npm run db:seed-outlet-purchase`), idempotent —
only `outletId IS NULL` `Purchase` rows:
- derive `outletId` from the row's `warehouse.outletId` where `warehouseId` is set and the warehouse
  has an outlet; remaining (no warehouse, or a central MAIN/null-outlet warehouse) → "Ovenisto Main
  Branch" (looked up by name; abort if missing; throw if any row remains NULL after; log counts).
- `PurchaseRequest` has no column → no backfill.

Run once after deploy (same pattern as prior backfills).

---

## Testing

**Backend:** `npm run typecheck` (0) and `npm run test` (47 still pass — B4a adds no new pure helper;
reuses B1's tested `resolveCreateOutlet`/`resolveOutletScope`).

**Backend live verify (after deploy + backfill):**
- Super Admin scoped to outlet A: create a purchase against A's warehouse → in A's list, NOT B's.
- Create a no-warehouse purchase while on "All" → 400.
- Get/update/delete another outlet's purchase by id → 404.
- PurchaseRequest list scoped; approve/reject/cancel/get another outlet's PR by id → 404.
- Dashboard `payable` for outlet A = sum of A's `Purchase.due` (differs from the all-outlets payable).
- Backfill: after `db:seed-outlet-purchase`, no `outletId IS NULL` purchases remain.

**Frontend:** manual smoke — switching the header outlet changes Purchases + PurchaseRequests pages and
the dashboard payable figure.

---

## Files (B4a)

**Backend:**
- Modify: `prisma/schema.prisma` (Purchase + outletId/relation/index; Outlet `purchases` back-relation)
- Modify: `src/modules/purchases/purchase.controller.ts` (getPurchases, getPurchase, createPurchase, updatePurchase, deletePurchase)
- Modify: `src/modules/purchase-requests/purchase-request.controller.ts` (getPurchaseRequests, getPurchaseRequest, createPurchaseRequest, approveRequest, rejectRequest, cancelRequest)
- Modify: `src/modules/reports/reports.controller.ts` (getDashboard payable)
- Create: `src/seeds/outletPurchaseBackfill.ts`; add `db:seed-outlet-purchase` to `package.json`

**Frontend:** none.

---

## Reuse / Next

B4a applies the B-phase recipe to one denormalized-column module (Purchase) and one
derive-via-warehouse module (PurchaseRequest), and finishes the Dashboard payable. **B4b** then handles
the two-warehouse `StockChallan` + `StockDemand` — scoped via an OR over their two warehouse relations'
outlets (MAIN-inclusive, per the brainstorming decision), with by-id guards placed BEFORE the
stock-mutating status transitions (dispatch/receive/cancel/approve).
