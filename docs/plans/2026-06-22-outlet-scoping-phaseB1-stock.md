# Outlet Scoping — Phase B1 (Stock & Production) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Outlet-scope the Stock & Production domain — add `outletId` to StockAdjustment/StockTake/Production/WasteRecord, stamp it on create, filter the six stock list endpoints by the acting outlet, and backfill existing rows.

**Architecture:** Reuse Phase A's `resolveOutletScope(req)`. Add a sibling helper `resolveCreateOutlet(req, warehouseOutletId?)` that returns the outlet to stamp (warehouse outlet, else the user's scope, else 400 for a Super-Admin-on-"All"). Filtering uses `where.outletId = scope`; `Transfer` (already two-outlet) uses an OR over `fromOutletId`/`toOutletId`. A one-time idempotent seed backfills existing rows. No frontend changes — the stock pages already send `X-Outlet-Id` and refetch on outlet-switch (Phase A).

**Tech Stack:** Express + TypeScript + Prisma + PostgreSQL (Neon), ESM with `.js` import extensions, vitest. Backend only.

## Global Constraints

- Super Admin role string is exactly `'Super Admin'`. The "all" sentinel is exactly `'all'`.
- `resolveOutletScope(req)` (Phase A, exists) returns `null` (Super Admin on "All") or an outlet id.
- `resolveCreateOutlet(req, warehouseOutletId?)` returns a non-null outlet id string, or THROWS `ApiError.badRequest('Select a specific outlet before creating')` when it cannot determine one (Super Admin on "All" with no warehouse). The 400 message is exactly `Select a specific outlet before creating`.
- New `outletId` columns are NULLABLE (`String?`), matching `Order.outletId`. Schema sync is `prisma db push` (Neon) — NEVER `migrate dev` in prod.
- Strict scoping: every stock row resolves to a concrete outlet. The central "Main Warehouse" (type=main, `outletId` null) and any warehouse-less rows backfill to the **"Ovenisto Main Branch"** outlet (looked up by name; abort if missing).
- Decimal fields stay `Number()`-converted in responses (unchanged from existing handlers).
- ESM: import local modules with the `.js` extension.
- Backend tests: vitest, files under `__tests__/` named `*.test.ts`; run with `npm run test`.
- Work on `main`; commits stay LOCAL until the user says push. No Claude/AI mention in commit messages.

---

## File Structure

- `prisma/schema.prisma` — add `outletId` + `outlet` relation + `@@index([outletId])` to 4 models; add 4 back-relations to `Outlet`.
- `src/middleware/outletScope.ts` — add `resolveCreateOutlet` next to `resolveOutletScope`.
- `src/middleware/__tests__/outletScope.test.ts` — add `resolveCreateOutlet` cases.
- `src/modules/stock/stock.controller.ts` — stamp on create (5 handlers) + filter on read (5 handlers).
- `src/seeds/outletStockBackfill.ts` — one-time backfill (new); `package.json` — add `db:seed-outlet-stock`.

**Task order:** T1 (schema) → T2 (helper + tests) → T3 (create stamping) → T4 (read filtering) → T5 (backfill script). T3 and T4 both edit `stock.controller.ts` but are sequential (no parallel dispatch).

---

## Task 1: Schema — add `outletId` to four stock models

**Files:**
- Modify: `prisma/schema.prisma` (models `StockAdjustment`, `StockTake`, `Production`, `WasteRecord`, `Outlet`)

**Interfaces:**
- Produces: a nullable `outletId String?` + `outlet Outlet?` relation on each of the 4 models; `StockAdjustment[]`, `StockTake[]`, `Production[]`, `WasteRecord[]` back-relations on `Outlet`. Later tasks stamp/filter `outletId`.

- [ ] **Step 1: Add the column + relation to each of the four models**

In `prisma/schema.prisma`, in the `StockAdjustment` model, add these three lines (place `outletId` near the other scalar FK fields like `warehouseId`, the relation near the other relations, and the index with the other `@@index` lines):

```prisma
  outletId     String?
```
```prisma
  outlet     Outlet?    @relation(fields: [outletId], references: [id])
```
```prisma
  @@index([outletId])
```

In the `StockTake` model add:
```prisma
  outletId           String?
```
```prisma
  outlet    Outlet?         @relation(fields: [outletId], references: [id])
```
```prisma
  @@index([outletId])
```

In the `Production` model add:
```prisma
  outletId   String?
```
```prisma
  outlet     Outlet?  @relation(fields: [outletId], references: [id])
```
```prisma
  @@index([outletId])
```

In the `WasteRecord` model add:
```prisma
  outletId   String?
```
```prisma
  outlet     Outlet?  @relation(fields: [outletId], references: [id])
```
```prisma
  @@index([outletId])
```

- [ ] **Step 2: Add the back-relations to the `Outlet` model**

In the `Outlet` model's `// Relations` block (it already has `users`, `warehouses`, `orders`, `transfersFrom`, etc.), add:

```prisma
  stockAdjustments StockAdjustment[]
  stockTakes       StockTake[]
  productions      Production[]
  wasteRecords     WasteRecord[]
```

- [ ] **Step 3: Validate + generate the client**

Run: `cd Ovenisto-backend && npx prisma validate && npm run db:generate`
Expected: `The schema at prisma/schema.prisma is valid` and Prisma Client generates with no errors. (If validate complains about a missing back-relation, you missed one of the four in Step 2 — add it.)

- [ ] **Step 4: Sync the schema to the database**

Run: `cd Ovenisto-backend && npm run db:push`
Expected: "Your database is now in sync with your Prisma schema." (Adds four nullable columns — non-destructive, no data loss prompt.)

- [ ] **Step 5: Commit**

```bash
cd Ovenisto-backend
git add prisma/schema.prisma
git commit -m "Add outletId to StockAdjustment, StockTake, Production, WasteRecord"
```

---

## Task 2: `resolveCreateOutlet` helper + tests

**Files:**
- Modify: `src/middleware/outletScope.ts`
- Test: `src/middleware/__tests__/outletScope.test.ts`

**Interfaces:**
- Consumes: `resolveOutletScope(req)` (same file, Phase A); `ApiError` from `../utils/ApiError.js`.
- Produces: `resolveCreateOutlet(req: Request, warehouseOutletId?: string | null): string` — returns the outlet id to stamp, or throws `ApiError.badRequest('Select a specific outlet before creating')`.

- [ ] **Step 1: Write the failing tests**

In `src/middleware/__tests__/outletScope.test.ts`, the existing `mockReq` helper builds a request from `{ role, userOutletId, headerOutlet, queryOutlet }`. Append this block at the end of the file:

```ts
import { resolveCreateOutlet } from '../outletScope.js';

describe('resolveCreateOutlet', () => {
  it('returns the warehouse outlet when given (ignores scope)', () => {
    expect(resolveCreateOutlet(mockReq({ role: 'Super Admin' }), 'o1')).toBe('o1');
  });

  it('falls back to the user scope when no warehouse outlet', () => {
    expect(resolveCreateOutlet(mockReq({ role: 'Manager', userOutletId: 'o2' }))).toBe('o2');
  });

  it('Super Admin on "All" with no warehouse throws 400 with the exact message', () => {
    expect(() => resolveCreateOutlet(mockReq({ role: 'Super Admin' })))
      .toThrow('Select a specific outlet before creating');
  });

  it('Super Admin targeting a specific outlet via header, no warehouse → that outlet', () => {
    expect(resolveCreateOutlet(mockReq({ role: 'Super Admin', headerOutlet: 'o3' }))).toBe('o3');
  });

  it('treats a null warehouse outlet as "not given" and uses scope', () => {
    expect(resolveCreateOutlet(mockReq({ role: 'Manager', userOutletId: 'o2' }), null)).toBe('o2');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd Ovenisto-backend && npx vitest run src/middleware/__tests__/outletScope.test.ts`
Expected: FAIL — `resolveCreateOutlet is not a function` / not exported.

- [ ] **Step 3: Implement the helper**

In `src/middleware/outletScope.ts`, add the `ApiError` import at the top (next to the existing imports):

```ts
import { ApiError } from '../utils/ApiError.js';
```

Then add, below `resolveOutletScope`:

```ts
/**
 * Returns the outlet id to stamp on a NEW outlet-owned row.
 *   warehouseOutletId given (truthy) → use it (the stock's physical outlet)
 *   else → the acting user's scope (resolveOutletScope)
 *   if that is null (Super Admin on "All", no warehouse) → 400, must pick an outlet.
 * A non-super-admin always resolves to their own outlet (never reaches the throw
 * unless they have no assigned outlet — the documented pre-existing edge).
 */
export function resolveCreateOutlet(req: Request, warehouseOutletId?: string | null): string {
  if (warehouseOutletId) return warehouseOutletId;
  const scope = resolveOutletScope(req);
  if (scope) return scope;
  throw ApiError.badRequest('Select a specific outlet before creating');
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd Ovenisto-backend && npx vitest run src/middleware/__tests__/outletScope.test.ts`
Expected: PASS — all `resolveCreateOutlet` cases plus the existing `resolveOutletScope` cases.

- [ ] **Step 5: Full suite + typecheck**

Run: `cd Ovenisto-backend && npm run test && npm run typecheck`
Expected: all tests pass; tsc exits 0.

- [ ] **Step 6: Commit**

```bash
cd Ovenisto-backend
git add src/middleware/outletScope.ts src/middleware/__tests__/outletScope.test.ts
git commit -m "Add resolveCreateOutlet helper for stamping outlet on new stock rows"
```

---

## Task 3: Stamp `outletId` on create (stock controller)

**Files:**
- Modify: `src/modules/stock/stock.controller.ts` (`createAdjustment`, `startStockTake`, `createProduction`, `createWasteRecord`, `wasteDoughBatch`)

**Interfaces:**
- Consumes: `resolveCreateOutlet(req, warehouseOutletId?)` (Task 2). `Warehouse` has an `outletId` field (nullable).
- Produces: new StockAdjustment / StockTake / Production / WasteRecord rows carry `outletId`.

- [ ] **Step 1: Import the helper**

At the top of `src/modules/stock/stock.controller.ts`, add:

```ts
import { resolveCreateOutlet } from '../../middleware/outletScope.js';
```

- [ ] **Step 2: `createAdjustment` — derive outlet from the warehouse (else user scope), stamp it**

In `createAdjustment`, after the existing ingredient lookup (`const ingredient = await prisma.ingredient.findUnique(...)` and its `if (!ingredient) throw`), and before `const adjustedById = req.user?.id;`, add:

```ts
  const adjWarehouse = warehouseId
    ? await prisma.warehouse.findUnique({ where: { id: warehouseId }, select: { outletId: true } })
    : null;
  const outletId = resolveCreateOutlet(req, adjWarehouse?.outletId);
```

Then in the `tx.stockAdjustment.create({ data: { ... } })` block, add `outletId` to the `data` (place it right after the `warehouseId: warehouseId || null,` line):

```ts
        warehouseId: warehouseId || null,
        outletId,
```

- [ ] **Step 3: `startStockTake` — stamp the user's scope (no warehouse on this handler)**

In `startStockTake`, after `const { notes } = req.body;`, add:

```ts
  const outletId = resolveCreateOutlet(req);
```

Then in the `prisma.stockTake.create({ data: { ... } })` block, add `outletId` right after the `notes: notes || null,` line:

```ts
      notes: notes || null,
      outletId,
```

- [ ] **Step 4: `createProduction` — resolve scope once, stamp the Production + its internal dough adjustment, and place the dough batch in the resolved outlet's kitchen**

In `createProduction`, after the two validation throws (`if (!itemName?.trim())...` and `if (!quantity...)`), add:

```ts
  const prodOutletId = resolveCreateOutlet(req);
```

In the `tx.production.create({ data: { ... } })` block, add `outletId` right after the `notes: notes || null,` line:

```ts
        notes: notes || null,
        outletId: prodOutletId,
```

In the Path-B kitchen-warehouse resolution, replace the user-outlet lookup so a Super Admin produces into the SELECTED outlet's kitchen. Find:

```ts
        const outletId = req.user?.outletId ?? null;
        const kw = await tx.warehouse.findFirst({
          where: { type: 'KITCHEN' as never, isActive: true, ...(outletId ? { outletId } : {}) },
          select: { id: true },
        });
```

Replace with:

```ts
        const kw = await tx.warehouse.findFirst({
          where: { type: 'KITCHEN' as never, isActive: true, outletId: prodOutletId },
          select: { id: true },
        });
```

In the internal `tx.stockAdjustment.create({ data: { ... } })` inside Path B, add `outletId` right after its `warehouseId: whId,` line:

```ts
          warehouseId: whId,
          outletId: prodOutletId,
```

- [ ] **Step 5: `createWasteRecord` — stamp the user's scope**

In `createWasteRecord`, after `if (!itemName?.trim()) throw ...`, add:

```ts
  const outletId = resolveCreateOutlet(req);
```

In the `tx.wasteRecord.create({ data: { ... } })` block, add `outletId` right after the `recordedBy: req.user?.name || null,` line:

```ts
        recordedBy: req.user?.name || null,
        outletId,
```

- [ ] **Step 6: `wasteDoughBatch` — derive outlet from the batch's warehouse**

In `wasteDoughBatch`, extend the batch query `select` to include the warehouse outlet. Find:

```ts
      select: {
        remainingQty: true, ingredientId: true,
        ingredient: { select: { name: true, purchasePrice: true, unit: { select: { name: true } } } },
      },
```

Replace with:

```ts
      select: {
        remainingQty: true, ingredientId: true,
        warehouse: { select: { outletId: true } },
        ingredient: { select: { name: true, purchasePrice: true, unit: { select: { name: true } } } },
      },
```

Then, after `if (!batch) throw ApiError.notFound('Batch not found');`, add:

```ts
    const wasteOutletId = resolveCreateOutlet(req, batch.warehouse?.outletId);
```

In the final `tx.wasteRecord.create({ data: { ... } })`, add `outletId` right after the `reason: 'Expired (short shelf life)',` line:

```ts
        reason: 'Expired (short shelf life)',
        outletId: wasteOutletId,
```

- [ ] **Step 7: Typecheck + full suite**

Run: `cd Ovenisto-backend && npm run typecheck && npm run test`
Expected: tsc exits 0; all tests pass (you changed no tests — the helper tests from Task 2 still pass).

- [ ] **Step 8: Commit**

```bash
cd Ovenisto-backend
git add src/modules/stock/stock.controller.ts
git commit -m "Stamp outletId on new stock adjustments, takes, productions, and waste"
```

---

## Task 4: Filter the stock list endpoints by outlet

**Files:**
- Modify: `src/modules/stock/stock.controller.ts` (`getAdjustments`, `getStockTakes`, `getProductions`, `getWasteRecords`, `getTransfers`)

**Interfaces:**
- Consumes: `resolveOutletScope(req)` (Phase A — already imported in this file? if not, import it).
- Produces: each list is filtered to the acting outlet (Super Admin "All" → unfiltered; Transfer → sender OR receiver).

- [ ] **Step 1: Ensure `resolveOutletScope` is imported**

At the top of `src/modules/stock/stock.controller.ts`, confirm there is an import for `resolveOutletScope`. Task 3 imported `resolveCreateOutlet` from `../../middleware/outletScope.js`; change that import to bring in both:

```ts
import { resolveCreateOutlet, resolveOutletScope } from '../../middleware/outletScope.js';
```

- [ ] **Step 2: `getAdjustments` — replace the inline warehouse-OR scoping with the column filter**

In `getAdjustments`, find the current scoping block:

```ts
  if (warehouseId) {
    where.warehouseId = String(warehouseId);
  } else if (req.user?.role !== 'Super Admin' && req.user?.outletId) {
    // Outlet scoping: non-Super Admin sees only their outlet's warehouse adjustments
    where.warehouse = {
      OR: [{ outletId: req.user.outletId }, { type: 'MAIN' }],
    };
  }
```

Replace it with (keep the explicit-warehouse filter, switch the outlet scoping to the new column):

```ts
  if (warehouseId) where.warehouseId = String(warehouseId);
  const scope = resolveOutletScope(req);
  if (scope) where.outletId = scope;
```

- [ ] **Step 3: `getStockTakes` — give it the request and filter**

The handler signature currently ignores the request (`async (_req, res)`). Change it to use `req` and add the filter. Find:

```ts
export const getStockTakes = asyncHandler(async (_req: Request, res: Response) => {
  const takes = await prisma.stockTake.findMany({
    orderBy: { createdAt: 'desc' },
    include: { items: { include: { ingredient: { select: { id: true, name: true, unit: { select: { name: true } } } } } } },
  });
  res.json(ApiResponse.success(takes));
});
```

Replace with:

```ts
export const getStockTakes = asyncHandler(async (req: Request, res: Response) => {
  const scope = resolveOutletScope(req);
  const takes = await prisma.stockTake.findMany({
    where: scope ? { outletId: scope } : {},
    orderBy: { createdAt: 'desc' },
    include: { items: { include: { ingredient: { select: { id: true, name: true, unit: { select: { name: true } } } } } } },
  });
  res.json(ApiResponse.success(takes));
});
```

- [ ] **Step 4: `getProductions` — add the filter**

In `getProductions`, after `const where: any = {};` (and the existing `if (search) ...` line), add:

```ts
  const scope = resolveOutletScope(req);
  if (scope) where.outletId = scope;
```

- [ ] **Step 5: `getWasteRecords` — add the filter**

In `getWasteRecords`, after `const where: any = {};` (and the existing `if (search) ...` line), add:

```ts
  const scope = resolveOutletScope(req);
  if (scope) where.outletId = scope;
```

- [ ] **Step 6: `getTransfers` — OR over from/to (a transfer involves two outlets)**

In `getTransfers`, after `const where: any = {};` (and the existing `if (status) ...` line), add:

```ts
  const scope = resolveOutletScope(req);
  if (scope) where.OR = [{ fromOutletId: scope }, { toOutletId: scope }];
```

- [ ] **Step 7: Typecheck + full suite**

Run: `cd Ovenisto-backend && npm run typecheck && npm run test`
Expected: tsc exits 0 (note: `getStockTakes` now uses `req`, so the `_req` rename removes any unused-param issue); all tests pass.

- [ ] **Step 8: Commit**

```bash
cd Ovenisto-backend
git add src/modules/stock/stock.controller.ts
git commit -m "Filter stock lists by outlet (adjustments, takes, productions, waste, transfers)"
```

---

## Task 5: Backfill existing rows (one-time seed)

**Files:**
- Create: `src/seeds/outletStockBackfill.ts`
- Modify: `package.json` (add `db:seed-outlet-stock`)

**Interfaces:**
- Consumes: Prisma client; the existing seed style in `src/seeds/warehouseMigration.ts` (run via `tsx`).
- Produces: an idempotent backfill, runnable with `npm run db:seed-outlet-stock`.

- [ ] **Step 1: Write the backfill script**

Create `src/seeds/outletStockBackfill.ts`:

```ts
/**
 * One-time, idempotent backfill of outletId on stock rows (Phase B1).
 * Only touches rows where outletId IS NULL.
 *   - StockAdjustment / StockTake: derive from the row's warehouse.outletId when present;
 *     otherwise (no warehouse, or a warehouse with a null outlet) → "Ovenisto Main Branch".
 *   - Production / WasteRecord: no warehouse link → "Ovenisto Main Branch".
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

  // 1. StockAdjustment — derive from warehouse outlet where possible.
  const adjustments = await prisma.stockAdjustment.findMany({
    where: { outletId: null },
    select: { id: true, warehouse: { select: { outletId: true } } },
  });
  let adjDerived = 0, adjFallback = 0;
  for (const a of adjustments) {
    const outletId = a.warehouse?.outletId ?? fallback;
    if (a.warehouse?.outletId) adjDerived++; else adjFallback++;
    await prisma.stockAdjustment.update({ where: { id: a.id }, data: { outletId } });
  }

  // 2. StockTake — same rule.
  const takes = await prisma.stockTake.findMany({
    where: { outletId: null },
    select: { id: true, warehouse: { select: { outletId: true } } },
  });
  let takeDerived = 0, takeFallback = 0;
  for (const t of takes) {
    const outletId = t.warehouse?.outletId ?? fallback;
    if (t.warehouse?.outletId) takeDerived++; else takeFallback++;
    await prisma.stockTake.update({ where: { id: t.id }, data: { outletId } });
  }

  // 3. Production — all NULL → fallback.
  const prodRes = await prisma.production.updateMany({
    where: { outletId: null },
    data: { outletId: fallback },
  });

  // 4. WasteRecord — all NULL → fallback.
  const wasteRes = await prisma.wasteRecord.updateMany({
    where: { outletId: null },
    data: { outletId: fallback },
  });

  // 5. Report + verify nothing left NULL.
  const stillNull = {
    adjustments: await prisma.stockAdjustment.count({ where: { outletId: null } }),
    takes: await prisma.stockTake.count({ where: { outletId: null } }),
    productions: await prisma.production.count({ where: { outletId: null } }),
    waste: await prisma.wasteRecord.count({ where: { outletId: null } }),
  };

  console.log('[outletStockBackfill] done:', {
    adjustments: { derived: adjDerived, fallback: adjFallback },
    takes: { derived: takeDerived, fallback: takeFallback },
    productions: prodRes.count,
    waste: wasteRes.count,
    stillNull,
  });

  const remaining = Object.values(stillNull).reduce((s, n) => s + n, 0);
  if (remaining > 0) {
    throw new Error(`Backfill incomplete: ${remaining} rows still have a null outletId.`);
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => { console.error(e); process.exit(1); });
```

- [ ] **Step 2: Add the npm script**

In `package.json`, in the `scripts` block, add (next to `db:seed-warehouses`):

```json
    "db:seed-outlet-stock": "tsx src/seeds/outletStockBackfill.ts",
```

- [ ] **Step 3: Typecheck the script**

Run: `cd Ovenisto-backend && npm run typecheck`
Expected: tsc exits 0 (the script's `prisma` queries reference the new `outletId` field, which Task 1 added to the client).

- [ ] **Step 4: Commit**

```bash
cd Ovenisto-backend
git add src/seeds/outletStockBackfill.ts package.json
git commit -m "Add one-time outlet backfill seed for stock and production rows"
```

> The backfill is RUN once after deploy (`npm run db:seed-outlet-stock`), not during the build — same operational pattern as `db:seed-warehouses`. It is captured in the final verification, not executed as part of any task here.

---

## Final Verification (after all tasks)

- [ ] `cd Ovenisto-backend && npm run test && npm run typecheck` → all pass, tsc 0.
- [ ] Whole-branch review (subagent-driven-development's final reviewer, most capable model).
- [ ] **Deploy + backfill (with user consent to push):** push → Railway boots (the 4 columns are added by the on-boot `db:push`) → run `npm run db:seed-outlet-stock` once against prod → confirm it logs `stillNull` all-zero.
- [ ] **Live verify:** as Super Admin scoped to outlet A — create a production, an adjustment (in A's warehouse), a waste, a stock-take → each appears in A's scoped list, NOT in B's; create any while on "All Outlets" → 400 with the exact message; a Transfer A→B appears in BOTH A's and B's transfer lists.
- [ ] Commits remain LOCAL — push only on explicit user instruction.

## Notes for B2–B5

Same recipe: add nullable `outletId` → backfill → stamp via `resolveCreateOutlet` → filter via `resolveOutletScope`. `Transfer`'s OR filter is the template for any two-outlet entity. Customer & Supplier stay chain-wide (never scoped).
