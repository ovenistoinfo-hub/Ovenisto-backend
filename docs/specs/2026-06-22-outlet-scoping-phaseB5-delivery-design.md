# Phase B5 — Outlet Scoping: Delivery (DeliveryRider + DeliveryAssignment)

**Date:** 2026-06-22
**Status:** Approved design
**Depends on:** Phase A (`resolveOutletScope`, `X-Outlet-Id` header; `Order.outletId`). The **final** outlet-scoping sub-phase.

---

## 1. Goal

Outlet-scope the Delivery module so a non-admin user (Manager / Delivery Manager / Cashier at a branch)
sees and acts only on their own outlet's riders and delivery assignments; a Super Admin sees everything on
"All Outlets" and one outlet's delivery data when a specific outlet is selected via the `X-Outlet-Id` header.
Backend-only.

## 2. Non-Goals / Why This Is Simple

- **No schema change, no backfill, no frontend change.** Both `DeliveryRider` and `DeliveryAssignment`
  lack an `outletId` column, and neither gets one — outlet is **derived** at query time (like Phase B4b).
- **The Rider portal is unaffected.** `getMyAssignments` / `getMyStats` resolve the caller's own
  `DeliveryRider` profile by `userId` and filter by `riderId`; a rider seeing their own deliveries is
  independent of outlet scope. These two handlers are NOT changed.
- No change to the delivery workflow (assignment status machine, cash collection, rider availability math).

## 3. Scoping Model — Two Derive Paths

`scope = resolveOutletScope(req)` (Super Admin → `X-Outlet-Id` or `null` for "all"; every other role pinned
to `req.user.outletId`). When `scope === null`, no filter is applied (see everything).

- **Riders** derive outlet from their linked **User account** (`DeliveryRider.userId → User.outletId`).
  Riders are fundamentally `role=RIDER` Users — `getRiders` is built from the user table. A rider is in
  scope iff `scope == null` OR `rider.user.outletId === scope`. A rider with no linked user (vestigial
  standalone profile) has no outlet and is invisible to a scoped user — acceptable, since `getRiders` only
  surfaces `role=RIDER` users anyway.
- **Assignments** derive outlet from their **Order** (`DeliveryAssignment.orderId → Order.outletId`, already
  scoped since Phase A). An assignment is in scope iff `scope == null` OR `assignment.order.outletId === scope`.

## 4. Files & Changes

Single file: `src/modules/delivery/delivery.controller.ts`. It uses the **static** `ApiError` helpers
(`ApiError.notFound(...)`, `ApiError.badRequest(...)`) — match that style. Import `resolveOutletScope` from
`../../middleware/outletScope.js`. All delivery routes already carry `authenticate` + `authorize(...)` (route
audit passed; the B2 silent-null risk does not apply).

**Rider handlers (derive via `user.outletId`):**
- `getRiders` — currently lists `prisma.user.findMany({ where: { role:'RIDER', status:'active' }, ... })`.
  Add the scope filter to that user query: `where: { role:'RIDER', status:'active', ...(scope ? { outletId: scope } : {}) }`.
  Change the signature from `_req` to `req`.
- `createRider` — if `scope` is set and a `userId` is provided, after loading that user require
  `user.outletId === scope`, else throw `ApiError.badRequest('Rider user is not in your outlet')`. (No
  `userId` → standalone rider with no outlet; left as-is, an accepted edge.)
- `updateRider` — extend the load to `include: { user: { select: { outletId: true } } }`; after the
  not-found check, `if (scope && rider.user?.outletId !== scope) throw ApiError.notFound('Rider not found')`.
- `getRiderStats` — extend the load with `user: { select: { outletId: true } }`; same by-id guard after
  not-found.

**Assignment handlers (derive via `order.outletId`):**
- `getAssignments` — add `if (scope) where.order = { outletId: scope }` to the existing `where`.
- `assignRider` — already loads `order` and `rider`. Add, before the `$transaction`: `if (scope && order.outletId !== scope) throw ApiError.notFound('Order not found')`; and load the rider with
  `include: { user: { select: { outletId: true } } }` then `if (scope && rider.user?.outletId !== scope) throw ApiError.badRequest('Rider is not in your outlet')`.
- `updateAssignmentStatus` — extend the load (currently `include: { rider: true }`) with
  `order: { select: { outletId: true } }`; after the not-found check and **before** the `$transaction`,
  `if (scope && assignment.order?.outletId !== scope) throw ApiError.notFound('Assignment not found')`.
  (This route is also called by **Riders**; a rider's scope is their own outlet and they only carry their
  branch's orders, so the guard passes for legitimate own-deliveries.)
- `collectAmount` — extend the load with `order: { select: { outletId: true } }`; by-id guard after
  not-found, before the update.

**Aggregate:**
- `getDeliveryDashboard` — change `_req` to `req`; scope the three queries: riders
  `findMany({ where: scope ? { user: { outletId: scope } } : {}, ... })`; today-deliveries and
  active-assignments each add `order: { outletId: scope }` to their `where` when `scope` is set.

**Unchanged:** `getMyAssignments`, `getMyStats` (rider's own data, keyed by their `riderId`).

## 5. Error Handling

- Cross-outlet by-id access (rider or assignment) → **404** (`'Rider not found'` / `'Assignment not found'`),
  never leak existence — mirrors prior phases.
- Cross-outlet create/assign → **400/403** with a specific message.
- Existing status-machine / collection errors unchanged.

## 6. Verification

The backend has **no test runner** (vitest is frontend-only). Verification is `npm run typecheck` (clean) +
`npm run build` + live API checks. Do **not** author backend `.test.ts` files.

**Live (prod):**
- `GET /delivery/riders` and `GET /delivery/assignments` totals differ across `X-Outlet-Id: all` vs Main vs DHA.
- Cross-outlet by-id: a Main rider's `GET /delivery/riders/:id/stats` and a Main assignment's
  `PUT /delivery/assignments/:id/status` / `/collect` as DHA → 404; as Main → 200 (or the normal response).
- Cross-outlet `POST /delivery/assign` (a Main order, or a Main rider, as DHA) → 404/400, no assignment created.
- `GET /delivery/dashboard` riderStats + activeAssignments differ per outlet.
- Rider portal: `GET /delivery/my-assignments` and `/my-stats` still return the rider's own data (unchanged).

## 7. Out of Scope / Follow-ups

- This completes the outlet-scoping initiative for operational data. `Customer` / `Supplier` remain
  chain-wide by design.
- Deferred from B1: `createTransfer` body-outlet forge guard.
- Deferred from B4b: a data-integrity assertion that BRANCH/KITCHEN warehouses always have a non-null
  `outletId` (the warehouse-derived scoping invariant).
