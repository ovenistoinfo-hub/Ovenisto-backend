# Outlet Scoping — Phase B4a (Purchases & Purchase Requests) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Outlet-scope Purchases and Purchase Requests — add `outletId` to Purchase, scope/stamp/guard both controllers, and make the Dashboard "payable" metric per-outlet.

**Architecture:** Reuse Phase A's `resolveOutletScope(req): string|null` and B1's `resolveCreateOutlet(req, warehouseOutletId?): string`. `Purchase` gets a denormalized `outletId` (its warehouse is optional). `PurchaseRequest` has no column — it derives outlet from its required BRANCH warehouse (filter via the warehouse relation; by-id guard via a lightweight `warehouse.outletId` lookup). Dashboard payable switches from a chain-wide `Supplier.totalDue` sum to a per-outlet `Purchase.due` sum. A one-time idempotent seed backfills `Purchase`. No frontend changes.

**Tech Stack:** Express + TypeScript + Prisma + PostgreSQL (Neon), ESM with `.js` import extensions, vitest. Backend only.

## Global Constraints

- Super Admin role string is exactly `'Super Admin'`; the "all" sentinel is exactly `'all'`.
- `resolveOutletScope(req)` returns `null` (Super Admin on "All", or no authenticated user) or an outlet id; non-super-admins are FORCED to their own outlet.
- `resolveCreateOutlet(req, warehouseOutletId?)` returns an outlet id or THROWS `ApiError.badRequest('Select a specific outlet before creating')` (exact message).
- By-id cross-outlet → `404`. EXACT messages: `Purchase not found` (purchase controller, via `new ApiError('Purchase not found', 404)` — that file's style) and `Purchase request not found` (PR controller, via `ApiError.notFound('Purchase request not found')` — that file's style).
- PR create outside scope → `ApiError.badRequest('Warehouse is not in your outlet')`.
- New `Purchase.outletId` is NULLABLE (`String?`). Schema sync is `prisma db push` (Neon) — never `migrate dev`.
- Backfill fallback outlet is exactly `Ovenisto Main Branch` (looked up by name; abort if missing).
- ESM `.js` import extension. Decimal fields stay `Number()`-mapped (unchanged).
- Work on `main`; commits stay LOCAL until the user says push. No Claude/AI mention in commit messages.

---

## File Structure

- `prisma/schema.prisma` — `Purchase` (+outletId/relation/index), `Outlet` (+`purchases` back-relation).
- `src/modules/purchases/purchase.controller.ts` — 5 handlers.
- `src/modules/purchase-requests/purchase-request.controller.ts` — list + by-id + create + 3 transitions.
- `src/modules/reports/reports.controller.ts` — `getDashboard` payable.
- `src/seeds/outletPurchaseBackfill.ts` (new) + `package.json` (`db:seed-outlet-purchase`).

**Task order:** T1 (schema) → T2 (purchase controller) → T3 (PR controller) → T4 (dashboard payable) → T5 (backfill). No new pure helper, so no TDD task — reuses B1's tested helpers; verification is typecheck + the existing suite + live checks.

---

## Task 1: Schema — `outletId` on Purchase

**Files:**
- Modify: `prisma/schema.prisma` (`Purchase`, `Outlet`)

**Interfaces:**
- Produces: nullable `outletId` + `outlet` relation on `Purchase`; `Outlet.purchases` back-relation.

- [ ] **Step 1: Add the column, relation, index to `Purchase`**

In `prisma/schema.prisma`, in the `Purchase` model, add `outletId` near the other scalar FKs (e.g. after `warehouseId`), the relation in the `// Relations` block, and an index before `@@map("purchases")`:

```prisma
  outletId          String?
```
```prisma
  outlet          Outlet?          @relation(fields: [outletId], references: [id])
```
```prisma
  @@index([outletId])
```

- [ ] **Step 2: Add the back-relation to `Outlet`**

In the `Outlet` model's relations block (it has `users`, `warehouses`, `orders`, `stockAdjustments`, `shifts`, `restaurantTables`, `expenses`, etc.), add:

```prisma
  purchases Purchase[]
```

- [ ] **Step 3: Validate + generate**

Run: `cd Ovenisto-backend && npx prisma validate && npm run db:generate`
Expected: `The schema at prisma/schema.prisma is valid` and the client generates.

- [ ] **Step 4: Sync to the database**

Run: `cd Ovenisto-backend && npm run db:push`
Expected: "Your database is now in sync with your Prisma schema." (Adds one nullable column — non-destructive.)

- [ ] **Step 5: Commit**

```bash
cd Ovenisto-backend
git add prisma/schema.prisma
git commit -m "Add outletId to Purchase"
```

---

## Task 2: Purchase controller — scope, stamp, by-id guards

**Files:**
- Modify: `src/modules/purchases/purchase.controller.ts` (`getPurchases`, `getPurchase`, `createPurchase`, `updatePurchase`, `deletePurchase`)

**Interfaces:**
- Consumes: `resolveOutletScope(req)`, `resolveCreateOutlet(req, warehouseOutletId?)`.
- Produces: scoped purchase list; new purchases stamped; cross-outlet by-id access blocked.

> This file uses the `new ApiError('msg', 404)` CONSTRUCTOR form — match it in the guards.

- [ ] **Step 1: Import the helpers**

At the top of `src/modules/purchases/purchase.controller.ts`, add:

```ts
import { resolveOutletScope, resolveCreateOutlet } from '../../middleware/outletScope.js';
```

- [ ] **Step 2: `getPurchases` — filter the list**

In `getPurchases`, after the existing `where` building (`if (supplierId) ...`, `if (status) ...`), add (before the `Promise.all`):

```ts
  const scope = resolveOutletScope(req);
  if (scope) where.outletId = scope;
```

- [ ] **Step 3: `getPurchase` — by-id guard**

In `getPurchase`, find:

```ts
  if (!p) throw new ApiError('Purchase not found', 404);
  return res.json(ApiResponse.success(mapPurchase(p)));
```

Replace with:

```ts
  if (!p) throw new ApiError('Purchase not found', 404);
  const scope = resolveOutletScope(req);
  if (scope && p.outletId !== scope) throw new ApiError('Purchase not found', 404);
  return res.json(ApiResponse.success(mapPurchase(p)));
```

- [ ] **Step 4: `createPurchase` — derive warehouse outlet + stamp**

In `createPurchase`, after the `if (purchaseRequestId) { ... }` validation block (which ends just before `const paidAmount = Number(paid ?? 0);`), add:

```ts
  const pWarehouse = warehouseId
    ? await prisma.warehouse.findUnique({ where: { id: warehouseId }, select: { outletId: true } })
    : null;
  const outletId = resolveCreateOutlet(req, pWarehouse?.outletId);
```

Then in the `tx.purchase.create({ data: { ... } })` block, add `outletId` right after the `warehouseId: warehouseId || null,` line:

```ts
        warehouseId: warehouseId || null,
        outletId,
```

- [ ] **Step 5: `updatePurchase` — by-id guard**

In `updatePurchase`, find:

```ts
  const existing = await prisma.purchase.findUnique({ where: { id: req.params.id } });
  if (!existing) throw new ApiError('Purchase not found', 404);

  const totalAmount = Number(existing.total ?? 0);
```

Replace with:

```ts
  const existing = await prisma.purchase.findUnique({ where: { id: req.params.id } });
  if (!existing) throw new ApiError('Purchase not found', 404);
  const scope = resolveOutletScope(req);
  if (scope && existing.outletId !== scope) throw new ApiError('Purchase not found', 404);

  const totalAmount = Number(existing.total ?? 0);
```

- [ ] **Step 6: `deletePurchase` — by-id guard (before the reversal)**

In `deletePurchase`, find:

```ts
  const existing = await prisma.purchase.findUnique({ where: { id: req.params.id } });
  if (!existing) throw new ApiError('Purchase not found', 404);

  const items = (existing.items as any[]) || [];
```

Replace with:

```ts
  const existing = await prisma.purchase.findUnique({ where: { id: req.params.id } });
  if (!existing) throw new ApiError('Purchase not found', 404);
  const scope = resolveOutletScope(req);
  if (scope && existing.outletId !== scope) throw new ApiError('Purchase not found', 404);

  const items = (existing.items as any[]) || [];
```

- [ ] **Step 7: Typecheck + full suite**

Run: `cd Ovenisto-backend && npm run typecheck && npm run test`
Expected: tsc exits 0; all 47 tests still pass.

- [ ] **Step 8: Commit**

```bash
cd Ovenisto-backend
git add src/modules/purchases/purchase.controller.ts
git commit -m "Scope purchases by outlet: filter list, stamp create, by-id guards"
```

---

## Task 3: PurchaseRequest controller — scope list, by-id guards, create check

**Files:**
- Modify: `src/modules/purchase-requests/purchase-request.controller.ts` (`getPurchaseRequests`, `getPurchaseRequest`, `createPurchaseRequest`, `approveRequest`, `rejectRequest`, `cancelRequest`)

**Interfaces:**
- Consumes: `resolveOutletScope(req)`. `PurchaseRequest.warehouseId` is required (always a BRANCH warehouse with an outlet); guards check the warehouse's `outletId`.
- Produces: list scoped by warehouse outlet; cross-outlet by-id read/transition blocked; create restricted to the acting outlet's warehouse.

> This file uses the `ApiError.notFound(...)` / `ApiError.badRequest(...)` STATIC form — match it.

- [ ] **Step 1: Import the helper**

At the top of `src/modules/purchase-requests/purchase-request.controller.ts`, add:

```ts
import { resolveOutletScope } from '../../middleware/outletScope.js';
```

- [ ] **Step 2: `getPurchaseRequests` — replace the inline scoping with `resolveOutletScope`**

In `getPurchaseRequests`, find:

```ts
  // Role scoping: Super Admin sees all, others see their outlet's warehouses + MAIN
  if (req.user?.role !== SUPER_ADMIN) {
    if (req.user?.outletId) {
      where.warehouse = {
        OR: [
          { outletId: req.user.outletId },
          { type: 'MAIN' },
        ],
      };
    }
  }
```

Replace with:

```ts
  // Outlet scoping: filter by the target warehouse's outlet (a PR always targets a BRANCH warehouse).
  const scope = resolveOutletScope(req);
  if (scope) where.warehouse = { outletId: scope };
```

- [ ] **Step 3: `getPurchaseRequest` — by-id guard**

In `getPurchaseRequest`, after `if (!pr) throw ApiError.notFound('Purchase request not found');`, add:

```ts
  const scope = resolveOutletScope(req);
  if (scope) {
    const wh = await prisma.warehouse.findUnique({ where: { id: pr.warehouseId }, select: { outletId: true } });
    if (wh?.outletId !== scope) throw ApiError.notFound('Purchase request not found');
  }
```

- [ ] **Step 4: `createPurchaseRequest` — generalize the outlet check**

In `createPurchaseRequest`, find:

```ts
  // Non-Super Admin: warehouse must belong to user's outlet
  if (req.user?.role !== SUPER_ADMIN && warehouse.outletId !== req.user?.outletId) {
    throw ApiError.forbidden('You can only create requests for your own outlet');
  }
```

Replace with:

```ts
  // Outlet scoping: the target warehouse must be in the acting outlet (Super Admin on "All" may target any branch).
  const scope = resolveOutletScope(req);
  if (scope && warehouse.outletId !== scope) {
    throw ApiError.badRequest('Warehouse is not in your outlet');
  }
```

- [ ] **Step 5: `approveRequest` — by-id guard**

In `approveRequest`, find:

```ts
  if (!pr) throw ApiError.notFound('Purchase request not found');
  if (pr.status !== 'PENDING') throw ApiError.badRequest(`Cannot approve a ${pr.status} request`);
```

Replace with:

```ts
  if (!pr) throw ApiError.notFound('Purchase request not found');
  const scope = resolveOutletScope(req);
  if (scope) {
    const wh = await prisma.warehouse.findUnique({ where: { id: pr.warehouseId }, select: { outletId: true } });
    if (wh?.outletId !== scope) throw ApiError.notFound('Purchase request not found');
  }
  if (pr.status !== 'PENDING') throw ApiError.badRequest(`Cannot approve a ${pr.status} request`);
```

- [ ] **Step 6: `rejectRequest` — by-id guard**

In `rejectRequest`, find:

```ts
  const pr = await prisma.purchaseRequest.findUnique({ where: { id } });
  if (!pr) throw ApiError.notFound('Purchase request not found');
  if (pr.status !== 'PENDING') throw ApiError.badRequest(`Cannot reject a ${pr.status} request`);
```

Replace with:

```ts
  const pr = await prisma.purchaseRequest.findUnique({ where: { id } });
  if (!pr) throw ApiError.notFound('Purchase request not found');
  const scope = resolveOutletScope(req);
  if (scope) {
    const wh = await prisma.warehouse.findUnique({ where: { id: pr.warehouseId }, select: { outletId: true } });
    if (wh?.outletId !== scope) throw ApiError.notFound('Purchase request not found');
  }
  if (pr.status !== 'PENDING') throw ApiError.badRequest(`Cannot reject a ${pr.status} request`);
```

- [ ] **Step 7: `cancelRequest` — by-id guard**

In `cancelRequest`, find:

```ts
  const pr = await prisma.purchaseRequest.findUnique({ where: { id } });
  if (!pr) throw ApiError.notFound('Purchase request not found');
  if (pr.status !== 'PENDING') throw ApiError.badRequest(`Cannot cancel a ${pr.status} request`);
```

Replace with:

```ts
  const pr = await prisma.purchaseRequest.findUnique({ where: { id } });
  if (!pr) throw ApiError.notFound('Purchase request not found');
  const scope = resolveOutletScope(req);
  if (scope) {
    const wh = await prisma.warehouse.findUnique({ where: { id: pr.warehouseId }, select: { outletId: true } });
    if (wh?.outletId !== scope) throw ApiError.notFound('Purchase request not found');
  }
  if (pr.status !== 'PENDING') throw ApiError.badRequest(`Cannot cancel a ${pr.status} request`);
```

(The existing requester-only check `if (pr.requestedById !== req.user!.id) throw ApiError.forbidden(...)` stays below this guard — leave it unchanged.)

- [ ] **Step 8: Typecheck + full suite**

Run: `cd Ovenisto-backend && npm run typecheck && npm run test`
Expected: tsc exits 0; all 47 tests still pass.

- [ ] **Step 9: Commit**

```bash
cd Ovenisto-backend
git add src/modules/purchase-requests/purchase-request.controller.ts
git commit -m "Scope purchase requests by outlet: list filter, by-id guards, create check"
```

---

## Task 4: Dashboard payable — per-outlet from Purchase.due

**Files:**
- Modify: `src/modules/reports/reports.controller.ts` (`getDashboard`)

**Interfaces:**
- Consumes: the `outletFilter` const already defined in `getDashboard` (Phase A/B1).
- Produces: `payable` computed per-outlet from `Purchase.due`.

- [ ] **Step 1: Replace the supplier aggregation with a scoped purchase aggregation**

In `getDashboard`, find:

```ts
  const [supplierAgg, customerAgg, topCustomers, settings] = await Promise.all([
    prisma.supplier.aggregate({ _sum: { totalDue: true } }),
    prisma.customer.aggregate({ _sum: { outstandingDue: true } }),
```

Replace with:

```ts
  const [purchaseAgg, customerAgg, topCustomers, settings] = await Promise.all([
    prisma.purchase.aggregate({ where: { ...outletFilter }, _sum: { due: true } }),
    prisma.customer.aggregate({ _sum: { outstandingDue: true } }),
```

- [ ] **Step 2: Update the payable computation**

A few lines below, find:

```ts
  const payable = Math.round(Number(supplierAgg._sum.totalDue ?? 0));
```

Replace with:

```ts
  const payable = Math.round(Number(purchaseAgg._sum.due ?? 0));
```

(Leave `receivable`, `topCustomersMapped`, and `settings` unchanged — only the payable source changes.)

- [ ] **Step 3: Typecheck + full suite**

Run: `cd Ovenisto-backend && npm run typecheck && npm run test`
Expected: tsc exits 0; all 47 tests still pass.

- [ ] **Step 4: Commit**

```bash
cd Ovenisto-backend
git add src/modules/reports/reports.controller.ts
git commit -m "Scope dashboard payable to the selected outlet (from Purchase.due)"
```

---

## Task 5: Backfill existing purchases (one-time seed)

**Files:**
- Create: `src/seeds/outletPurchaseBackfill.ts`
- Modify: `package.json` (add `db:seed-outlet-purchase`)

**Interfaces:**
- Consumes: Prisma client; the seed style in `src/seeds/outletStockBackfill.ts` (run via `tsx`).
- Produces: an idempotent backfill, runnable with `npm run db:seed-outlet-purchase`.

- [ ] **Step 1: Write the backfill script**

Create `src/seeds/outletPurchaseBackfill.ts`:

```ts
/**
 * One-time, idempotent backfill of outletId on Purchase (Phase B4a).
 * Only touches rows where outletId IS NULL.
 *   - derive from the row's warehouse.outletId where warehouseId is set and the warehouse has an outlet;
 *   - otherwise (no warehouse, or a central MAIN/null-outlet warehouse) → "Ovenisto Main Branch".
 * Safe to re-run.
 */
import { prisma } from '../config/database.js';

const MAIN_BRANCH_NAME = 'Ovenisto Main Branch';

async function main() {
  const mainBranch = await prisma.outlet.findFirst({
    where: { name: MAIN_BRANCH_NAME },
    select: { id: true },
  });
  if (!mainBranch) {
    throw new Error(`Backfill aborted: outlet "${MAIN_BRANCH_NAME}" not found.`);
  }
  const fallback = mainBranch.id;

  const purchases = await prisma.purchase.findMany({
    where: { outletId: null },
    select: { id: true, warehouse: { select: { outletId: true } } },
  });
  let derived = 0, fellBack = 0;
  for (const p of purchases) {
    const outletId = p.warehouse?.outletId ?? fallback;
    if (p.warehouse?.outletId) derived++; else fellBack++;
    await prisma.purchase.update({ where: { id: p.id }, data: { outletId } });
  }

  const stillNull = await prisma.purchase.count({ where: { outletId: null } });

  console.log('[outletPurchaseBackfill] done:', { purchases: { derived, fallback: fellBack }, stillNull });

  if (stillNull > 0) {
    throw new Error(`Backfill incomplete: ${stillNull} purchases still have a null outletId.`);
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => { console.error(e); process.exit(1); });
```

- [ ] **Step 2: Add the npm script**

In `package.json`, in the `scripts` block, add (next to `db:seed-outlet-expense`):

```json
    "db:seed-outlet-purchase": "tsx src/seeds/outletPurchaseBackfill.ts",
```

- [ ] **Step 3: Typecheck**

Run: `cd Ovenisto-backend && npm run typecheck`
Expected: tsc exits 0 (references the new `outletId` field + the `warehouse` relation, on the generated client from Task 1).

- [ ] **Step 4: Commit**

```bash
cd Ovenisto-backend
git add src/seeds/outletPurchaseBackfill.ts package.json
git commit -m "Add one-time outlet backfill seed for purchases"
```

> Run once after deploy (`npm run db:seed-outlet-purchase`), not during the build. Captured in final verification, not executed by any task here.

---

## Final Verification (after all tasks)

- [ ] `cd Ovenisto-backend && npm run test && npm run typecheck` → all pass, tsc 0.
- [ ] Whole-branch review (subagent-driven-development's final reviewer, most capable model).
- [ ] **Deploy + backfill (with user consent to push):** push → Railway boots (the column added by on-boot `db:push`) → run `npm run db:seed-outlet-purchase` once against prod → confirm `stillNull` is 0.
- [ ] **Live verify:** Super Admin scoped to outlet A — create a purchase against A's warehouse → appears in A's list, NOT B's; create a no-warehouse purchase on "All" → 400; get/update/delete another outlet's purchase by id → 404; PR list scoped; approve/reject/cancel/get another outlet's PR by id → 404; Dashboard payable for A = sum of A's `Purchase.due` (differs from the all-outlets payable).
- [ ] Commits remain LOCAL — push only on explicit user instruction.

## Notes for B4b

B4b scopes the two-warehouse `StockChallan` + `StockDemand`: NO denormalized column — filter via an OR over the two warehouse relations' outlets (MAIN-inclusive: a row is in scope if its from/to (or requesting/supplying) warehouse is in the acting outlet OR is a MAIN warehouse). The lists already have partial OR-scoping; the gap is the by-id reads and the stock-mutating status transitions (dispatch/receive/cancel challan; approve-demand auto-creates a challan) — place each outlet guard BEFORE the transaction that mutates warehouse stock.
