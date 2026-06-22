# Phase B4b — Outlet Scoping: StockChallan + StockDemand — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Outlet-scope the two-warehouse inter-warehouse transfer flow (StockChallan + StockDemand) so non-admin users see/act only on transfers touching their outlet, unifying both controllers under `resolveOutletScope`.

**Architecture:** Pure controller changes in two files — no schema change, no backfill (outlet is *derived* from the two warehouse relations). Each list query gains a strict-endpoint OR-filter; each by-id handler gains an outlet guard placed before any stock mutation; each create handler gains an originating-warehouse scope check.

**Tech Stack:** Express + TypeScript + Prisma. Existing helper `resolveOutletScope` from `src/middleware/outletScope.ts`.

## Global Constraints

- **Scoping rule (strict-endpoint):** a row is in scope iff `scope == null` OR one of its two warehouses' `outletId === scope`, where `scope = resolveOutletScope(req)`.
- **`resolveOutletScope(req)`** returns: Super Admin → the `X-Outlet-Id` header value, or `null` for `'all'`/absent; every other role → `req.user?.outletId ?? null`. A `null` scope means **no filter** (see all) — this is intended for admins and central main-warehouse staff (who have no `outletId`).
- **No schema change, no backfill, no frontend change.**
- **ApiError style in both files:** `throw new ApiError('message', statusCode)` (constructor form). Do not use the static `ApiError.notFound(...)` helpers here.
- **By-id cross-outlet response:** `new ApiError('Challan not found', 404)` / `new ApiError('Demand not found', 404)` — never leak existence.
- **Cross-outlet create response:** `403` with a specific message.
- **Keep** the existing transfer workflow untouched: status machine, warehouse-type pair rules, stock/batch math, and the demand approval-authority role gates (`BRANCH→MAIN` needs Super Admin; `KITCHEN→BRANCH` blocks Super Admin). The outlet guard is *additional*.
- **No test runner exists for the backend** (vitest is frontend-only). Per-task verification = `npm run typecheck` (must print no errors) + `npm run build` (must succeed). Do **not** create backend `.test.ts` files.
- All commits are **local only** until the human says "push".

---

### Task 1: Outlet-scope the Challan controller

**Files:**
- Modify: `src/modules/challans/challan.controller.ts`

**Interfaces:**
- Consumes: `resolveOutletScope(req: Request): string | null` from `../../middleware/outletScope.js`.
- Produces: nothing new exported; behavior change only.

**Context:** `CHALLAN_INCLUDE` (lines 14-38) already selects `fromWarehouse`/`toWarehouse` with `outletId`. The list currently scopes via a local `getUserScopeWhIds` helper + `ADMIN_ROLES` const; both are being removed. `receiveChallan` has a partial outlet check that is being replaced by the unified guard. Handlers `dispatchChallan` and `cancelChallan` load the challan with a bare `findUnique({ where })` and must be extended to include the two warehouses' `outletId`.

- [ ] **Step 1: Add the import**

At the top of the file, after the `userHelpers.js` import (line 9), add:

```ts
import { resolveOutletScope } from '../../middleware/outletScope.js';
```

- [ ] **Step 2: Remove `ADMIN_ROLES` and add the scope guard helper**

Replace the `ADMIN_ROLES` const (line 11):

```ts
const ADMIN_ROLES = ['Super Admin', 'Admin'];
```

with a by-id guard helper:

```ts
// B4b: throw 404 if the acting outlet owns neither warehouse of this challan.
// scope === null (admins, central main-warehouse staff) → no restriction.
function assertChallanInScope(
  req: Request,
  fromOutletId: string | null | undefined,
  toOutletId: string | null | undefined,
): void {
  const scope = resolveOutletScope(req);
  if (scope && fromOutletId !== scope && toOutletId !== scope) {
    throw new ApiError('Challan not found', 404);
  }
}
```

- [ ] **Step 3: Delete the `getUserScopeWhIds` helper**

Delete the entire helper (currently lines 103-112):

```ts
// Resolve warehouse IDs visible to a non-admin user
async function getUserScopeWhIds(outletId: string | null | undefined): Promise<string[]> {
  if (outletId) {
    const whs = await prisma.warehouse.findMany({ where: { outletId }, select: { id: true } });
    return whs.map(w => w.id);
  }
  // No outletId → main-warehouse staff; scope to MAIN type warehouses
  const whs = await prisma.warehouse.findMany({ where: { type: 'MAIN' }, select: { id: true } });
  return whs.map(w => w.id);
}
```

- [ ] **Step 4: Replace the `getChallans` list-scoping block**

In `getChallans`, replace the W6 block (currently lines 122-132):

```ts
  // W6: Outlet-scoped filtering for non-admin users
  if (!ADMIN_ROLES.includes(req.user?.role || '')) {
    const whIds = await getUserScopeWhIds(req.user?.outletId);
    if (whIds.length === 0) {
      return res.json(ApiResponse.success([]));
    }
    where.OR = [
      { fromWarehouseId: { in: whIds } },
      { toWarehouseId:   { in: whIds } },
    ];
  }
```

with the unified strict-endpoint filter:

```ts
  // B4b: strict-endpoint outlet scoping. scope===null (admins / central
  // main-warehouse staff) → no filter, matching the Demand controller.
  const scope = resolveOutletScope(req);
  if (scope) {
    where.OR = [
      { fromWarehouse: { outletId: scope } },
      { toWarehouse:   { outletId: scope } },
    ];
  }
```

> Intended consequence: a non-admin central main-warehouse user (no `outletId`) now sees all challans instead of only MAIN-warehouse ones. This matches how `getDemands` already treats such users and is not a regression — do not flag it.

- [ ] **Step 5: Add the by-id guard to `getChallan`**

In `getChallan`, after the not-found check (currently line 176), add the guard before returning:

```ts
export const getChallan = asyncHandler(async (req: Request, res: Response) => {
  const c = await prisma.stockChallan.findUnique({
    where: { id: req.params.id },
    include: CHALLAN_INCLUDE,
  });
  if (!c) throw new ApiError('Challan not found', 404);
  assertChallanInScope(req, c.fromWarehouse?.outletId, c.toWarehouse?.outletId);
  return res.json(ApiResponse.success(mapChallan(c)));
});
```

- [ ] **Step 6: Add the scope check to `createChallan`**

In `createChallan`, immediately after the BRANCH→KITCHEN same-outlet check (currently lines 209-212), add:

```ts
  // BRANCH → KITCHEN: must be the same outlet
  if (fromWH.type === 'BRANCH' && fromWH.outletId !== toWH.outletId) {
    throw new ApiError('Branch can only transfer to its own outlet\'s kitchen', 400);
  }

  // B4b: a scoped (non-admin) user may only originate transfers from their own
  // outlet's warehouse. Central main-warehouse staff have no outletId → scope
  // null → no restriction (preserves MAIN→branch dispatch creation).
  const scope = resolveOutletScope(req);
  if (scope && fromWH.outletId !== scope) {
    throw new ApiError('From warehouse is not in your outlet', 403);
  }
```

- [ ] **Step 7: Add the by-id guard to `dispatchChallan`**

In `dispatchChallan`, extend the load to include the warehouse outletIds and add the guard after the not-found check (currently lines 244-246):

```ts
export const dispatchChallan = asyncHandler(async (req: Request, res: Response) => {
  const challan = await prisma.stockChallan.findUnique({
    where: { id: req.params.id },
    include: {
      fromWarehouse: { select: { outletId: true } },
      toWarehouse:   { select: { outletId: true } },
    },
  });
  if (!challan) throw new ApiError('Challan not found', 404);
  assertChallanInScope(req, challan.fromWarehouse?.outletId, challan.toWarehouse?.outletId);
  if (challan.status !== 'PENDING') throw new ApiError('Only pending challans can be dispatched', 400);
```

(The rest of the handler is unchanged — `challan.fromWarehouseId` and `challan.toWarehouseId` scalar fields remain available alongside the included relations.)

- [ ] **Step 8: Replace the partial check in `receiveChallan` with the unified guard**

In `receiveChallan`, extend the load to also include `fromWarehouse.outletId` (currently lines 313-317):

```ts
export const receiveChallan = asyncHandler(async (req: Request, res: Response) => {
  const challan = await prisma.stockChallan.findUnique({
    where: { id: req.params.id },
    include: {
      fromWarehouse: { select: { outletId: true } },
      toWarehouse:   { select: { outletId: true, type: true } },
    },
  });
  if (!challan) throw new ApiError('Challan not found', 404);
  if (challan.status !== 'DISPATCHED') throw new ApiError('Only dispatched challans can be received', 400);

  // Super Admin dispatches, does not receive
  if (req.user?.role === 'Super Admin') {
    throw new ApiError('Super Admin cannot receive challans — branch/kitchen staff must confirm receipt', 403);
  }
```

Then replace the old partial check (currently lines 326-330):

```ts
  // Non-admin users must belong to the destination warehouse's outlet
  const destOutlet = (challan as any).toWarehouse?.outletId;
  if (!ADMIN_ROLES.includes(req.user?.role ?? '') && req.user?.outletId && destOutlet && req.user.outletId !== destOutlet) {
    throw new ApiError('You can only receive challans destined to your outlet', 403);
  }
```

with the unified guard:

```ts
  // B4b: unified strict-endpoint outlet guard (replaces the old destination-only check)
  assertChallanInScope(req, challan.fromWarehouse?.outletId, challan.toWarehouse?.outletId);
```

- [ ] **Step 9: Add the by-id guard to `cancelChallan`**

In `cancelChallan`, extend the load and add the guard (currently lines 431-436):

```ts
export const cancelChallan = asyncHandler(async (req: Request, res: Response) => {
  const challan = await prisma.stockChallan.findUnique({
    where: { id: req.params.id },
    include: {
      fromWarehouse: { select: { outletId: true } },
      toWarehouse:   { select: { outletId: true } },
    },
  });
  if (!challan) throw new ApiError('Challan not found', 404);
  assertChallanInScope(req, challan.fromWarehouse?.outletId, challan.toWarehouse?.outletId);
  if (challan.status !== 'PENDING' && challan.status !== 'DISPATCHED') {
    throw new ApiError('Only pending or dispatched challans can be cancelled', 400);
  }
```

- [ ] **Step 10: Typecheck**

Run: `npm run typecheck`
Expected: completes with no errors (in particular, no "ADMIN_ROLES is declared but never read" or "getUserScopeWhIds is declared but never read" — both must be fully removed).

- [ ] **Step 11: Build**

Run: `npm run build`
Expected: `prisma generate` then `tsc` complete with exit code 0.

- [ ] **Step 12: Commit**

```bash
git add src/modules/challans/challan.controller.ts
git commit -m "feat(challans): outlet-scope StockChallan via resolveOutletScope (B4b)"
```

---

### Task 2: Outlet-scope the Demand controller

**Files:**
- Modify: `src/modules/demands/demand.controller.ts`

**Interfaces:**
- Consumes: `resolveOutletScope(req: Request): string | null` from `../../middleware/outletScope.js`.
- Produces: nothing new exported; behavior change only.

**Context:** The shared `INCLUDE` (lines 40-50) selects `requestingWH`/`supplyingWH` with `{ id, name, type }` but **not** `outletId`. `mapDemand` reads only `id/name/type` from those relations, so adding `outletId` to the selects is harmless. The list currently has a Super-Admin special case (only `BRANCH→MAIN` demands) plus a non-admin MAIN-inclusive block — both are removed. `approveDemand`, `rejectDemand`, `cancelDemand` use loads that do not include the warehouse `outletId`s and must be extended.

- [ ] **Step 1: Add the import**

At the top of the file, after the `userHelpers.js` import (line 9), add:

```ts
import { resolveOutletScope } from '../../middleware/outletScope.js';
```

- [ ] **Step 2: Add `outletId` to the shared `INCLUDE` warehouse selects and add the guard helper**

Replace the `INCLUDE` const's two warehouse selects (currently lines 41-42):

```ts
  requestingWH: { select: { id: true, name: true, type: true } },
  supplyingWH:  { select: { id: true, name: true, type: true } },
```

with:

```ts
  requestingWH: { select: { id: true, name: true, type: true, outletId: true } },
  supplyingWH:  { select: { id: true, name: true, type: true, outletId: true } },
```

Then, immediately after the `INCLUDE` const (after current line 50), add the guard helper:

```ts
// B4b: throw 404 if the acting outlet owns neither warehouse of this demand.
// scope === null (admins, central main-warehouse staff) → no restriction.
function assertDemandInScope(
  req: Request,
  reqOutletId: string | null | undefined,
  supOutletId: string | null | undefined,
): void {
  const scope = resolveOutletScope(req);
  if (scope && reqOutletId !== scope && supOutletId !== scope) {
    throw new ApiError('Demand not found', 404);
  }
}
```

- [ ] **Step 3: Replace the `getDemands` scoping block**

In `getDemands`, replace the entire "Outlet scoping" block (currently lines 59-83):

```ts
  // Outlet scoping
  if (req.user?.role === 'Super Admin') {
    // Super Admin only sees BRANCH→MAIN demands (not KITCHEN→BRANCH)
    const mainWarehouses = await prisma.warehouse.findMany({
      where: { type: 'MAIN' },
      select: { id: true },
    });
    const mainIds = mainWarehouses.map(w => w.id);
    if (mainIds.length > 0) {
      where.supplyingWHId = { in: mainIds };
    }
  } else if (req.user?.outletId) {
    // Non-Super Admin sees only demands involving their outlet's warehouses
    const userWarehouses = await prisma.warehouse.findMany({
      where: { OR: [{ outletId: req.user.outletId }, { type: 'MAIN' }] },
      select: { id: true },
    });
    const whIds = userWarehouses.map(w => w.id);
    if (whIds.length > 0) {
      where.OR = [
        { requestingWHId: { in: whIds } },
        { supplyingWHId: { in: whIds } },
      ];
    }
  }
```

with the unified strict-endpoint filter:

```ts
  // B4b: strict-endpoint outlet scoping. Super Admin on "All" (scope===null)
  // now sees BOTH demand directions; on a selected outlet, only that outlet's.
  const scope = resolveOutletScope(req);
  if (scope) {
    where.OR = [
      { requestingWH: { outletId: scope } },
      { supplyingWH:  { outletId: scope } },
    ];
  }
```

- [ ] **Step 4: Add the by-id guard to `getDemand`**

In `getDemand`, add the guard after the not-found check (currently lines 116-117):

```ts
export const getDemand = asyncHandler(async (req: Request, res: Response) => {
  const d = await prisma.stockDemand.findUnique({ where: { id: req.params.id }, include: INCLUDE });
  if (!d) throw new ApiError('Demand not found', 404);
  assertDemandInScope(req, d.requestingWH?.outletId, d.supplyingWH?.outletId);
  return res.json(ApiResponse.success(mapDemand(d)));
});
```

- [ ] **Step 5: Add the scope check to `createDemand`**

In `createDemand`, after the not-found checks for `reqWH`/`supWH` (currently lines 137-138), add the originating-warehouse scope check:

```ts
  if (!reqWH) throw new ApiError('Requesting warehouse not found', 404);
  if (!supWH) throw new ApiError('Supplying warehouse not found', 404);

  // B4b: a scoped (non-admin) user may only raise a demand for their own
  // outlet's requesting warehouse. scope null (admins / central staff) → no check.
  const scope = resolveOutletScope(req);
  if (scope && reqWH.outletId !== scope) {
    throw new ApiError('Requesting warehouse is not in your outlet', 403);
  }
```

- [ ] **Step 6: Add the by-id guard to `approveDemand`**

In `approveDemand`, extend the load to include both warehouses' `outletId` and add the guard right after the not-found check (currently lines 187-193):

```ts
export const approveDemand = asyncHandler(async (req: Request, res: Response) => {
  const demand = await prisma.stockDemand.findUnique({
    where: { id: req.params.id },
    include: {
      items: true,
      requestingWH: { select: { type: true, outletId: true } },
      supplyingWH:  { select: { outletId: true } },
    },
  });
  if (!demand) throw new ApiError('Demand not found', 404);
  assertDemandInScope(req, demand.requestingWH?.outletId, demand.supplyingWH?.outletId);
  if (demand.status !== 'PENDING') throw new ApiError('Only pending demands can be approved', 400);
```

(The existing approval-authority role gates below this — `BRANCH→MAIN` / `KITCHEN→BRANCH` — are unchanged.)

- [ ] **Step 7: Add the by-id guard to `rejectDemand`**

In `rejectDemand`, extend the load and add the guard (currently lines 279-285):

```ts
export const rejectDemand = asyncHandler(async (req: Request, res: Response) => {
  const demand = await prisma.stockDemand.findUnique({
    where: { id: req.params.id },
    include: {
      requestingWH: { select: { type: true, outletId: true } },
      supplyingWH:  { select: { outletId: true } },
    },
  });
  if (!demand) throw new ApiError('Demand not found', 404);
  assertDemandInScope(req, demand.requestingWH?.outletId, demand.supplyingWH?.outletId);
  if (demand.status !== 'PENDING') throw new ApiError('Only pending demands can be rejected', 400);
```

- [ ] **Step 8: Add the by-id guard to `cancelDemand`**

In `cancelDemand`, extend the load to include the warehouse outletIds and add the guard after the not-found check (currently lines 309-312):

```ts
export const cancelDemand = asyncHandler(async (req: Request, res: Response) => {
  const demand = await prisma.stockDemand.findUnique({
    where: { id: req.params.id },
    include: {
      requestingWH: { select: { outletId: true } },
      supplyingWH:  { select: { outletId: true } },
    },
  });
  if (!demand) throw new ApiError('Demand not found', 404);
  assertDemandInScope(req, demand.requestingWH?.outletId, demand.supplyingWH?.outletId);
  if (demand.status !== 'PENDING') throw new ApiError('Only pending demands can be cancelled', 400);
  // Only the requester can cancel their own demand
  if (demand.requestedById !== req.user?.id) throw new ApiError('You can only cancel your own demands', 403);
```

- [ ] **Step 9: Typecheck**

Run: `npm run typecheck`
Expected: completes with no errors.

- [ ] **Step 10: Build**

Run: `npm run build`
Expected: `prisma generate` then `tsc` complete with exit code 0.

- [ ] **Step 11: Commit**

```bash
git add src/modules/demands/demand.controller.ts
git commit -m "feat(demands): outlet-scope StockDemand via resolveOutletScope (B4b)"
```

---

## Post-Implementation (after both tasks merged — done by the human/controller, not a task)

- **Deploy:** push `main` → Railway auto-deploy (if it stalls, replicate `npm run build` locally then push an empty commit to re-trigger — see B4a notes).
- **No backfill** to run (B4b adds no column).
- **Live verification** (from the spec §6): challan & demand list totals differ across `X-Outlet-Id: all` vs Main vs DHA; cross-outlet by-id → 404, own → 200; cross-outlet dispatch/cancel/approve/reject → 404 (no state change); Super Admin on "All" sees both demand directions; a full demand→approve→dispatch→receive flow still works.

## Self-Review Notes (author)

- **Spec coverage:** §3 unified filter → T1 S4, T2 S3. §4.1 challan guards → T1 S5,7,8,9; createChallan → T1 S6; helper removal → T1 S2,3,4. §4.2 demand guards → T2 S4,6,7,8; createDemand → T2 S5; SA special-case removal → T2 S3; keep role gates → T2 S6 note. §5 error codes → Global Constraints + each step. §6 verification → Post-Implementation. All covered.
- **Type consistency:** helper names `assertChallanInScope` / `assertDemandInScope` used consistently; `resolveOutletScope` import path identical in both files; relation field names `fromWarehouse`/`toWarehouse` (challan), `requestingWH`/`supplyingWH` (demand) match the schema and existing includes.
- **No placeholders:** every code step shows the exact before/after.
