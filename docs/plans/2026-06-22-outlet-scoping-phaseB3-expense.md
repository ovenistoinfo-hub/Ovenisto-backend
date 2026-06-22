# Outlet Scoping — Phase B3 (Expense) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Outlet-scope Expenses — add `outletId`, scope the list + stamp on create + guard by-id reads/writes, and scope the P&L and Dashboard expense aggregations so per-branch net profit is correct.

**Architecture:** Reuse Phase A's `resolveOutletScope(req): string|null` and Phase B1's `resolveCreateOutlet(req, warehouseOutletId?): string` (no warehouse here → scope form, 400s a Super-Admin-on-"All"). Scope the two report aggregations (P&L + Dashboard) and retire the `expensesAreRestaurantWide` workaround flag. A one-time idempotent seed backfills existing expenses → "Ovenisto Main Branch". No frontend changes.

**Tech Stack:** Express + TypeScript + Prisma + PostgreSQL (Neon), ESM with `.js` import extensions, vitest. Backend only.

## Global Constraints

- Super Admin role string is exactly `'Super Admin'`; the "all" sentinel is exactly `'all'`.
- `resolveOutletScope(req)` returns `null` (Super Admin on "All", or no authenticated user) or an outlet id; non-super-admins are FORCED to their own outlet.
- `resolveCreateOutlet(req, warehouseOutletId?)` returns an outlet id or THROWS `ApiError.badRequest('Select a specific outlet before creating')` (the 400 message is exactly that).
- By-id cross-outlet access returns `404` with the exact message `Expense not found`. Match the controller's existing error style: `throw new ApiError('Expense not found', 404)` (this file uses the `new ApiError(msg, code)` constructor, NOT `ApiError.notFound`).
- New `outletId` column is NULLABLE (`String?`). Schema sync is `prisma db push` (Neon) — never `migrate dev`.
- Backfill fallback outlet is exactly `Ovenisto Main Branch` (looked up by name; abort if missing).
- `expensesAreRestaurantWide` stays in the P&L response shape but is now hard-coded `false`.
- ESM: import local modules with the `.js` extension. Decimal fields stay `Number()`-mapped (unchanged).
- Work on `main`; commits stay LOCAL until the user says push. No Claude/AI mention in commit messages.

---

## File Structure

- `prisma/schema.prisma` — `Expense` (+outletId/relation/index), `Outlet` (+`expenses` back-relation).
- `src/modules/expenses/expense.controller.ts` — 5 handlers (list scope, create stamp, 3 by-id guards).
- `src/modules/reports/reports.controller.ts` — `getPnlReport` expense scope + flag; `getDashboard` expense scope.
- `src/seeds/outletExpenseBackfill.ts` (new) + `package.json` (`db:seed-outlet-expense`).

**Task order:** T1 (schema) → T2 (expense controller) → T3 (reports) → T4 (backfill). No new pure helper, so no TDD task — reuses B1's tested helpers; verification is typecheck + the existing suite + live checks.

---

## Task 1: Schema — `outletId` on Expense

**Files:**
- Modify: `prisma/schema.prisma` (`Expense`, `Outlet`)

**Interfaces:**
- Produces: nullable `outletId` + `outlet` relation on `Expense`; `Outlet.expenses` back-relation.

- [ ] **Step 1: Add the column, relation, index to `Expense`**

In `prisma/schema.prisma`, in the `Expense` model, add `outletId` near the other scalar fields, the relation, and an index:

```prisma
  outletId      String?
```
```prisma
  outlet        Outlet?  @relation(fields: [outletId], references: [id])
```
```prisma
  @@index([outletId])
```

- [ ] **Step 2: Add the back-relation to `Outlet`**

In the `Outlet` model's relations block (it has `users`, `warehouses`, `orders`, `stockAdjustments`, `shifts`, `restaurantTables`, etc.), add:

```prisma
  expenses Expense[]
```

- [ ] **Step 3: Validate + generate**

Run: `cd Ovenisto-backend && npx prisma validate && npm run db:generate`
Expected: `The schema at prisma/schema.prisma is valid` and the client generates.

- [ ] **Step 4: Sync to the database**

Run: `cd Ovenisto-backend && npm run db:push`
Expected: "Your database is now in sync with your Prisma schema." (Adds one nullable column — non-destructive, no data-loss prompt.)

- [ ] **Step 5: Commit**

```bash
cd Ovenisto-backend
git add prisma/schema.prisma
git commit -m "Add outletId to Expense"
```

---

## Task 2: Expense controller — scope list, stamp create, guard by-id

**Files:**
- Modify: `src/modules/expenses/expense.controller.ts` (`getExpenses`, `getExpense`, `createExpense`, `updateExpense`, `deleteExpense`)

**Interfaces:**
- Consumes: `resolveOutletScope(req)`, `resolveCreateOutlet(req)`.
- Produces: scoped expense list; new expenses stamped; cross-outlet by-id access blocked.

- [ ] **Step 1: Import the helpers**

At the top of `src/modules/expenses/expense.controller.ts`, add:

```ts
import { resolveOutletScope, resolveCreateOutlet } from '../../middleware/outletScope.js';
```

- [ ] **Step 2: `getExpenses` — filter the list**

In `getExpenses`, after the existing `where` building (`if (category) ...`, `if (search) ...`), add (before the `Promise.all`):

```ts
  const scope = resolveOutletScope(req);
  if (scope) where.outletId = scope;
```

- [ ] **Step 3: `getExpense` — by-id guard**

Replace:

```ts
export const getExpense = asyncHandler(async (req: Request, res: Response) => {
  const e = await prisma.expense.findUnique({ where: { id: req.params.id } });
  if (!e) throw new ApiError('Expense not found', 404);
  return res.json(ApiResponse.success(mapExpense(e)));
});
```

with:

```ts
export const getExpense = asyncHandler(async (req: Request, res: Response) => {
  const e = await prisma.expense.findUnique({ where: { id: req.params.id } });
  if (!e) throw new ApiError('Expense not found', 404);
  const scope = resolveOutletScope(req);
  if (scope && e.outletId !== scope) throw new ApiError('Expense not found', 404);
  return res.json(ApiResponse.success(mapExpense(e)));
});
```

- [ ] **Step 4: `createExpense` — stamp `outletId`**

In `createExpense`, after `const recordedBy = req.user?.name || req.user?.email || null;`, add:

```ts
  const outletId = resolveCreateOutlet(req);
```

Then in the `prisma.expense.create({ data: { ... } })` block, add `outletId` right after the `recordedBy,` line:

```ts
      recordedBy,
      outletId,
```

- [ ] **Step 5: `updateExpense` — by-id guard**

In `updateExpense`, find:

```ts
  const existing = await prisma.expense.findUnique({ where: { id: req.params.id } });
  if (!existing) throw new ApiError('Expense not found', 404);

  const { category, description, amount, paymentMethod, reference, receipt, date } = req.body;
```

Replace with:

```ts
  const existing = await prisma.expense.findUnique({ where: { id: req.params.id } });
  if (!existing) throw new ApiError('Expense not found', 404);
  const scope = resolveOutletScope(req);
  if (scope && existing.outletId !== scope) throw new ApiError('Expense not found', 404);

  const { category, description, amount, paymentMethod, reference, receipt, date } = req.body;
```

- [ ] **Step 6: `deleteExpense` — by-id guard**

In `deleteExpense`, find:

```ts
  const existing = await prisma.expense.findUnique({ where: { id: req.params.id } });
  if (!existing) throw new ApiError('Expense not found', 404);
  await prisma.expense.delete({ where: { id: req.params.id } });
```

Replace with:

```ts
  const existing = await prisma.expense.findUnique({ where: { id: req.params.id } });
  if (!existing) throw new ApiError('Expense not found', 404);
  const scope = resolveOutletScope(req);
  if (scope && existing.outletId !== scope) throw new ApiError('Expense not found', 404);
  await prisma.expense.delete({ where: { id: req.params.id } });
```

- [ ] **Step 7: Typecheck + full suite**

Run: `cd Ovenisto-backend && npm run typecheck && npm run test`
Expected: tsc exits 0; all 47 tests still pass (no test changes).

- [ ] **Step 8: Commit**

```bash
cd Ovenisto-backend
git add src/modules/expenses/expense.controller.ts
git commit -m "Scope expenses by outlet: filter list, stamp create, by-id guards"
```

---

## Task 3: Reports — scope the expense aggregations (per-outlet net profit)

**Files:**
- Modify: `src/modules/reports/reports.controller.ts` (`getPnlReport` ~line 110-126, `getDashboard` ~line 270-273)

**Interfaces:**
- Consumes: the `outletId` already resolved by `getParams`/`getDashboard` via `resolveOutletScope` (Phase B1) — a `string | undefined`. The `getDashboard` `outletFilter` const already exists.
- Produces: P&L + Dashboard expenses filtered by outlet; the P&L `expensesAreRestaurantWide` flag now `false`.

- [ ] **Step 1: `getPnlReport` — scope the expense query**

In `getPnlReport`, find:

```ts
  // Expenses: Expense has NO outletId column, so it is always restaurant-wide.
  const expenseRows = await prisma.expense.findMany({
    where: { date: { gte, lte } },
    select: { amount: true, category: true },
  });
```

Replace with:

```ts
  // Expenses are now outlet-scoped (Phase B3); outletId is the resolved scope (undefined = all).
  const expenseRows = await prisma.expense.findMany({
    where: { ...(outletId ? { outletId } : {}), date: { gte, lte } },
    select: { amount: true, category: true },
  });
```

- [ ] **Step 2: `getPnlReport` — retire the workaround flag**

In the same handler, find:

```ts
  const expensesAreRestaurantWide = !!outletId && outletId !== 'all';
```

Replace with:

```ts
  const expensesAreRestaurantWide = false;   // expenses are now outlet-scoped (Phase B3)
```

(Leave the `expensesAreRestaurantWide` key in the `ApiResponse.success({ ... })` object unchanged — the frontend contract stays; it just always reports `false` now.)

- [ ] **Step 3: `getDashboard` — scope the expense query**

In `getDashboard`, find (the `outletFilter` const is already defined earlier in this handler):

```ts
    prisma.expense.findMany({ where: { date: { gte: mb.thisStart, lte: mb.thisEnd } }, select: { amount: true } }),
```

Replace with:

```ts
    prisma.expense.findMany({ where: { ...outletFilter, date: { gte: mb.thisStart, lte: mb.thisEnd } }, select: { amount: true } }),
```

If the line above it is a comment like `// --- expenses + waste this month (waste is outlet-scoped; Expense has no outletId yet → restaurant-wide) ---`, update it to:

```ts
  // --- expenses + waste this month (both outlet-scoped) ---
```

- [ ] **Step 4: Typecheck + full suite**

Run: `cd Ovenisto-backend && npm run typecheck && npm run test`
Expected: tsc exits 0; all 47 tests still pass.

- [ ] **Step 5: Commit**

```bash
cd Ovenisto-backend
git add src/modules/reports/reports.controller.ts
git commit -m "Scope P&L and dashboard expense totals by outlet (per-branch net profit)"
```

---

## Task 4: Backfill existing expenses (one-time seed)

**Files:**
- Create: `src/seeds/outletExpenseBackfill.ts`
- Modify: `package.json` (add `db:seed-outlet-expense`)

**Interfaces:**
- Consumes: Prisma client; the seed style in `src/seeds/outletStockBackfill.ts` (run via `tsx`).
- Produces: an idempotent backfill, runnable with `npm run db:seed-outlet-expense`.

- [ ] **Step 1: Write the backfill script**

Create `src/seeds/outletExpenseBackfill.ts`:

```ts
/**
 * One-time, idempotent backfill of outletId on Expense (Phase B3).
 * Only touches rows where outletId IS NULL. Expense has no derivable outlet link
 * (recordedBy is a free-text name, not a userId), so all NULL rows → "Ovenisto Main Branch".
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

  const res = await prisma.expense.updateMany({
    where: { outletId: null },
    data: { outletId: fallback },
  });

  const stillNull = await prisma.expense.count({ where: { outletId: null } });

  console.log('[outletExpenseBackfill] done:', { expenses: res.count, stillNull });

  if (stillNull > 0) {
    throw new Error(`Backfill incomplete: ${stillNull} expenses still have a null outletId.`);
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => { console.error(e); process.exit(1); });
```

- [ ] **Step 2: Add the npm script**

In `package.json`, in the `scripts` block, add (next to `db:seed-outlet-shifttable`):

```json
    "db:seed-outlet-expense": "tsx src/seeds/outletExpenseBackfill.ts",
```

- [ ] **Step 3: Typecheck**

Run: `cd Ovenisto-backend && npm run typecheck`
Expected: tsc exits 0 (the script references the new `outletId` field, on the generated client from Task 1).

- [ ] **Step 4: Commit**

```bash
cd Ovenisto-backend
git add src/seeds/outletExpenseBackfill.ts package.json
git commit -m "Add one-time outlet backfill seed for expenses"
```

> Run once after deploy (`npm run db:seed-outlet-expense`), not during the build. Captured in final verification, not executed by any task here.

---

## Final Verification (after all tasks)

- [ ] `cd Ovenisto-backend && npm run test && npm run typecheck` → all pass, tsc 0.
- [ ] Whole-branch review (subagent-driven-development's final reviewer, most capable model).
- [ ] **Deploy + backfill (with user consent to push):** push → Railway boots (the column added by on-boot `db:push`) → run `npm run db:seed-outlet-expense` once against prod → confirm `stillNull` is 0.
- [ ] **Live verify:** as Super Admin scoped to outlet A — create an expense → appears in A's list, NOT B's; create on "All Outlets" → 400; get/update/delete another outlet's expense by id → 404; the P&L report + Dashboard net profit for outlet A reflect only A's expenses (differs from the all-outlets net profit).
- [ ] Commits remain LOCAL — push only on explicit user instruction.

## Notes for B4–B5

Same recipe: add nullable `outletId` → backfill → stamp via `resolveCreateOutlet` → filter via `resolveOutletScope` → by-id guard `if (scope && row.outletId !== scope) throw notFound`. Audit each new endpoint's ROUTE for `authenticate` (the B2 lesson — a scoped handler on an unauthenticated route silently resolves scope to null). Remaining: B4 Procurement (Purchase/PurchaseRequest/StockChallan/StockDemand), B5 Delivery (DeliveryRider/DeliveryAssignment).
