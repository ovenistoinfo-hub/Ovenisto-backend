# Outlet Scoping — Phase B2 (Shifts & Tables) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Outlet-scope the cash register (Shift) and floor tables (RestaurantTable) — add `outletId`, make a register "open" and a table number unique PER OUTLET, scope the lists, stamp on create, guard by-id writes, and backfill existing rows.

**Architecture:** Reuse Phase A's `resolveOutletScope(req): string|null` and Phase B1's `resolveCreateOutlet(req, warehouseOutletId?): string` (no warehouse here → always the scope form, which 400s a Super-Admin-on-"All"). `RestaurantTable.number` changes from a global `@unique` to `@@unique([outletId, number])`. A one-time idempotent seed backfills (Shift ← cashier's outlet, else Main Branch; Table → Main Branch). No frontend changes.

**Tech Stack:** Express + TypeScript + Prisma + PostgreSQL (Neon), ESM with `.js` import extensions, vitest. Backend only.

## Global Constraints

- Super Admin role string is exactly `'Super Admin'`; the "all" sentinel is exactly `'all'`.
- `resolveOutletScope(req)` returns `null` (Super Admin on "All", or no authenticated user) or an outlet id; a non-super-admin is always forced to their own outlet.
- `resolveCreateOutlet(req, warehouseOutletId?)` returns an outlet id or THROWS `ApiError.badRequest('Select a specific outlet before creating')`. The 400 message is exactly that.
- `RestaurantTable.number` becomes unique PER OUTLET via `@@unique([outletId, number])`. `Shift.shiftNumber` stays globally `@unique`.
- A register is "already open" PER OUTLET; the existing message stays exactly `A shift is already open. Close it before opening a new one.`
- Duplicate table message stays exactly `Table ${number} already exists`.
- By-id cross-outlet access returns `404` (notFound), never 403 — exact messages `Shift not found` / `Table not found`.
- New `outletId` columns are NULLABLE (`String?`). Schema sync is `prisma db push` (Neon) — never `migrate dev`.
- Backfill fallback outlet is exactly `Ovenisto Main Branch` (looked up by name; abort if missing).
- ESM: import local modules with the `.js` extension. Decimal fields stay `Number()`-mapped (unchanged).
- Work on `main`; commits stay LOCAL until the user says push. No Claude/AI mention in commit messages.

---

## File Structure

- `prisma/schema.prisma` — `Shift` (+outletId), `RestaurantTable` (+outletId, number→composite unique), `Outlet` (+2 back-relations).
- `src/modules/shifts/shift.controller.ts` — getActiveShift, getShifts, createShift, closeShift.
- `src/modules/tables/table.controller.ts` — getTables, createTable, updateTable, deleteTable.
- `src/modules/tables/table.routes.ts` — add `authenticate` to `GET /`; fix the stale "public" comment.
- `src/seeds/outletShiftTableBackfill.ts` (new) + `package.json` (`db:seed-outlet-shifttable`).

**Task order:** T1 (schema) → T2 (shift controller) → T3 (table controller + routes) → T4 (backfill). No new pure helper, so no TDD task — B2 reuses B1's tested helpers; verification is typecheck + the existing suite + live checks.

---

## Task 1: Schema — `outletId` on Shift & RestaurantTable; per-outlet table number

**Files:**
- Modify: `prisma/schema.prisma` (`Shift`, `RestaurantTable`, `Outlet`)

**Interfaces:**
- Produces: nullable `outletId` + `outlet` relation on `Shift` and `RestaurantTable`; `RestaurantTable` uniqueness on `(outletId, number)`; `Outlet.shifts` / `Outlet.restaurantTables` back-relations.

- [ ] **Step 1: `Shift` — add the column, relation, index**

In `prisma/schema.prisma`, in the `Shift` model, add `outletId` near the other scalar FKs (e.g. after `cashierId`), the relation near the `cashier` relation, and an index:

```prisma
  outletId         String?
```
```prisma
  outlet  Outlet? @relation(fields: [outletId], references: [id])
```
```prisma
  @@index([outletId])
```

- [ ] **Step 2: `RestaurantTable` — add column/relation/index AND change `number` uniqueness**

In the `RestaurantTable` model, find:

```prisma
  number         String  @unique @db.VarChar(10)
```

Replace with (drop the field-level `@unique`):

```prisma
  number         String  @db.VarChar(10)
```

Then add the column + relation:

```prisma
  outletId       String?
```
```prisma
  outlet  Outlet? @relation(fields: [outletId], references: [id])
```

And add the composite unique + index as block attributes (next to `@@map`):

```prisma
  @@unique([outletId, number])
  @@index([outletId])
```

- [ ] **Step 3: `Outlet` — add the two back-relations**

In the `Outlet` model's relations block (it already has `users`, `warehouses`, `orders`, `stockAdjustments`, etc.), add:

```prisma
  shifts           Shift[]
  restaurantTables RestaurantTable[]
```

- [ ] **Step 4: Validate + generate**

Run: `cd Ovenisto-backend && npx prisma validate && npm run db:generate`
Expected: `The schema at prisma/schema.prisma is valid` and the client generates. (A missing back-relation fails validate — add it.)

- [ ] **Step 5: Sync to the database**

Run: `cd Ovenisto-backend && npm run db:push`
Expected: "Your database is now in sync with your Prisma schema." (Adds two nullable columns and swaps one unique index — non-destructive: existing rows have `outletId = NULL`, and the prior global-unique `number` values satisfy `(NULL, number)` because Postgres treats NULLs as distinct.)

- [ ] **Step 6: Commit**

```bash
cd Ovenisto-backend
git add prisma/schema.prisma
git commit -m "Add outletId to Shift and RestaurantTable; table number unique per outlet"
```

---

## Task 2: Shift controller — scope reads, per-outlet open register, stamp + guard

**Files:**
- Modify: `src/modules/shifts/shift.controller.ts` (`getActiveShift` ~39, `getShifts` ~45, `createShift` ~59, `closeShift` ~83)

**Interfaces:**
- Consumes: `resolveOutletScope(req)`, `resolveCreateOutlet(req)`.
- Produces: per-outlet open shift; scoped shift list; new shifts stamped; cross-outlet close blocked.

- [ ] **Step 1: Import the helpers**

At the top of `src/modules/shifts/shift.controller.ts`, add:

```ts
import { resolveOutletScope, resolveCreateOutlet } from '../../middleware/outletScope.js';
```

- [ ] **Step 2: `getActiveShift` — scope to the caller's outlet**

Find:

```ts
export const getActiveShift = asyncHandler(async (_req: Request, res: Response) => {
  const shift = await prisma.shift.findFirst({ where: { status: 'open' } });
  res.json(ApiResponse.success(shift ? mapShift(shift) : null));
});
```

Replace with:

```ts
export const getActiveShift = asyncHandler(async (req: Request, res: Response) => {
  const scope = resolveOutletScope(req);
  const shift = await prisma.shift.findFirst({ where: { status: 'open', ...(scope ? { outletId: scope } : {}) } });
  res.json(ApiResponse.success(shift ? mapShift(shift) : null));
});
```

- [ ] **Step 3: `getShifts` — filter the list**

In `getShifts`, after `const where: any = {};` and the existing `if (status) where.status = status;` line, add:

```ts
  const scope = resolveOutletScope(req);
  if (scope) where.outletId = scope;
```

- [ ] **Step 4: `createShift` — stamp + make the open-register check per-outlet**

In `createShift`, find:

```ts
  const existing = await prisma.shift.findFirst({ where: { status: 'open' } });
  if (existing) throw ApiError.badRequest('A shift is already open. Close it before opening a new one.');

  const shiftNumber = await generateShiftNumber();
```

Replace with:

```ts
  const outletId = resolveCreateOutlet(req);
  const existing = await prisma.shift.findFirst({ where: { status: 'open', outletId } });
  if (existing) throw ApiError.badRequest('A shift is already open. Close it before opening a new one.');

  const shiftNumber = await generateShiftNumber();
```

Then in the `prisma.shift.create({ data: { ... } })` block, add `outletId` right after the `cashierName: req.user?.name || null,` line:

```ts
      cashierName: req.user?.name || null,
      outletId,
```

- [ ] **Step 5: `closeShift` — by-id guard**

In `closeShift`, find:

```ts
  const shift = await prisma.shift.findUnique({ where: { id } });
  if (!shift) throw ApiError.notFound('Shift not found');
```

Replace with:

```ts
  const shift = await prisma.shift.findUnique({ where: { id } });
  if (!shift) throw ApiError.notFound('Shift not found');
  const scope = resolveOutletScope(req);
  if (scope && shift.outletId !== scope) throw ApiError.notFound('Shift not found');
```

- [ ] **Step 6: Typecheck + full suite**

Run: `cd Ovenisto-backend && npm run typecheck && npm run test`
Expected: tsc exits 0 (`getActiveShift` now uses `req`, so no unused-param); all 47 tests still pass.

- [ ] **Step 7: Commit**

```bash
cd Ovenisto-backend
git add src/modules/shifts/shift.controller.ts
git commit -m "Scope shifts by outlet: per-outlet open register, list filter, stamp + guard"
```

---

## Task 3: Table controller + routes — scope, per-outlet number, stamp + guards, auth on GET

**Files:**
- Modify: `src/modules/tables/table.controller.ts` (`getTables`, `createTable`, `updateTable`, `deleteTable`)
- Modify: `src/modules/tables/table.routes.ts` (`GET /`)

**Interfaces:**
- Consumes: `resolveOutletScope(req)`, `resolveCreateOutlet(req)`.
- Produces: scoped table list; per-outlet number uniqueness; new tables stamped; cross-outlet update/delete blocked.

- [ ] **Step 1: Route — require auth on `GET /tables` (fix the stale "public" comment)**

In `src/modules/tables/table.routes.ts`, find:

```ts
// Public — used by self-order kiosk (no auth required)
router.get('/', getTables);
```

Replace with:

```ts
// Staff floor management (the self-order kiosk reads its table number from the URL, not this endpoint)
router.get('/', authenticate, getTables);
```

(`authenticate` is already imported in this file.)

- [ ] **Step 2: Controller — import the helpers**

At the top of `src/modules/tables/table.controller.ts`, add:

```ts
import { resolveOutletScope, resolveCreateOutlet } from '../../middleware/outletScope.js';
```

- [ ] **Step 3: `getTables` — filter the list**

In `getTables`, after `const where: any = {};` and the existing `if (floor)` / `if (status)` lines, add:

```ts
  const scope = resolveOutletScope(req);
  if (scope) where.outletId = scope;
```

- [ ] **Step 4: `createTable` — stamp + per-outlet existence check**

In `createTable`, find:

```ts
  const existing = await prisma.restaurantTable.findUnique({ where: { number: String(number) } });
  if (existing) throw ApiError.badRequest(`Table ${number} already exists`);

  const table = await prisma.restaurantTable.create({
    data: {
      number: String(number).trim(),
      capacity: capacity ?? 4,
      floor: floor || null,
      shape: shape || null,
      status: status ?? 'available',
    },
  });
```

Replace with:

```ts
  const outletId = resolveCreateOutlet(req);
  const existing = await prisma.restaurantTable.findFirst({ where: { number: String(number), outletId } });
  if (existing) throw ApiError.badRequest(`Table ${number} already exists`);

  const table = await prisma.restaurantTable.create({
    data: {
      number: String(number).trim(),
      capacity: capacity ?? 4,
      floor: floor || null,
      shape: shape || null,
      status: status ?? 'available',
      outletId,
    },
  });
```

(`findUnique({ where: { number } })` no longer compiles — `number` is no longer a standalone unique field — so this change is also required for typecheck.)

- [ ] **Step 5: `updateTable` — by-id guard + scope the number-conflict check to the table's outlet**

In `updateTable`, find:

```ts
  const existing = await prisma.restaurantTable.findUnique({ where: { id } });
  if (!existing) throw ApiError.notFound('Table not found');

  // Check uniqueness if number is being changed
  if (number !== undefined && String(number) !== existing.number) {
    const conflict = await prisma.restaurantTable.findUnique({ where: { number: String(number) } });
    if (conflict) throw ApiError.badRequest(`Table ${number} already exists`);
  }
```

Replace with:

```ts
  const existing = await prisma.restaurantTable.findUnique({ where: { id } });
  if (!existing) throw ApiError.notFound('Table not found');
  const scope = resolveOutletScope(req);
  if (scope && existing.outletId !== scope) throw ApiError.notFound('Table not found');

  // Check uniqueness if number is being changed (within the same outlet)
  if (number !== undefined && String(number) !== existing.number) {
    const conflict = await prisma.restaurantTable.findFirst({ where: { number: String(number), outletId: existing.outletId } });
    if (conflict) throw ApiError.badRequest(`Table ${number} already exists`);
  }
```

- [ ] **Step 6: `deleteTable` — by-id guard**

In `deleteTable`, find:

```ts
  const existing = await prisma.restaurantTable.findUnique({ where: { id: req.params.id } });
  if (!existing) throw ApiError.notFound('Table not found');

  await prisma.restaurantTable.delete({ where: { id: req.params.id } });
```

Replace with:

```ts
  const existing = await prisma.restaurantTable.findUnique({ where: { id: req.params.id } });
  if (!existing) throw ApiError.notFound('Table not found');
  const scope = resolveOutletScope(req);
  if (scope && existing.outletId !== scope) throw ApiError.notFound('Table not found');

  await prisma.restaurantTable.delete({ where: { id: req.params.id } });
```

- [ ] **Step 7: Typecheck + full suite**

Run: `cd Ovenisto-backend && npm run typecheck && npm run test`
Expected: tsc exits 0; all 47 tests still pass.

- [ ] **Step 8: Commit**

```bash
cd Ovenisto-backend
git add src/modules/tables/table.controller.ts src/modules/tables/table.routes.ts
git commit -m "Scope tables by outlet: per-outlet number, list filter, stamp + guards, auth on GET"
```

---

## Task 4: Backfill existing rows (one-time seed)

**Files:**
- Create: `src/seeds/outletShiftTableBackfill.ts`
- Modify: `package.json` (add `db:seed-outlet-shifttable`)

**Interfaces:**
- Consumes: Prisma client; the seed style in `src/seeds/outletStockBackfill.ts` (run via `tsx`).
- Produces: an idempotent backfill, runnable with `npm run db:seed-outlet-shifttable`.

- [ ] **Step 1: Write the backfill script**

Create `src/seeds/outletShiftTableBackfill.ts`:

```ts
/**
 * One-time, idempotent backfill of outletId on Shift and RestaurantTable (Phase B2).
 * Only touches rows where outletId IS NULL.
 *   - Shift: derive from the shift's cashier (user.outletId); cashier null / no outlet → "Ovenisto Main Branch".
 *   - RestaurantTable: no derivable link → "Ovenisto Main Branch".
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

  // 1. Shift — derive from the cashier's outlet where possible.
  const shifts = await prisma.shift.findMany({
    where: { outletId: null },
    select: { id: true, cashier: { select: { outletId: true } } },
  });
  let shiftDerived = 0, shiftFallback = 0;
  for (const s of shifts) {
    const outletId = s.cashier?.outletId ?? fallback;
    if (s.cashier?.outletId) shiftDerived++; else shiftFallback++;
    await prisma.shift.update({ where: { id: s.id }, data: { outletId } });
  }

  // 2. RestaurantTable — all NULL → fallback.
  const tableRes = await prisma.restaurantTable.updateMany({
    where: { outletId: null },
    data: { outletId: fallback },
  });

  // 3. Report + verify nothing left NULL.
  const stillNull = {
    shifts: await prisma.shift.count({ where: { outletId: null } }),
    tables: await prisma.restaurantTable.count({ where: { outletId: null } }),
  };

  console.log('[outletShiftTableBackfill] done:', {
    shifts: { derived: shiftDerived, fallback: shiftFallback },
    tables: tableRes.count,
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

In `package.json`, in the `scripts` block, add (next to `db:seed-outlet-stock`):

```json
    "db:seed-outlet-shifttable": "tsx src/seeds/outletShiftTableBackfill.ts",
```

- [ ] **Step 3: Typecheck**

Run: `cd Ovenisto-backend && npm run typecheck`
Expected: tsc exits 0 (the script references the new `outletId` field + the `cashier` relation, both on the generated client from Task 1).

- [ ] **Step 4: Commit**

```bash
cd Ovenisto-backend
git add src/seeds/outletShiftTableBackfill.ts package.json
git commit -m "Add one-time outlet backfill seed for shifts and tables"
```

> Run once after deploy (`npm run db:seed-outlet-shifttable`), not during the build — same operational pattern as `db:seed-outlet-stock`. Captured in final verification, not executed by any task here.

---

## Final Verification (after all tasks)

- [ ] `cd Ovenisto-backend && npm run test && npm run typecheck` → all pass, tsc 0.
- [ ] Whole-branch review (subagent-driven-development's final reviewer, most capable model).
- [ ] **Deploy + backfill (with user consent to push):** push → Railway boots (columns + the `number` constraint swap applied by on-boot `db:push`) → run `npm run db:seed-outlet-shifttable` once against prod → confirm `stillNull` all-zero.
- [ ] **Live verify:** open a register in outlet A → `getActiveShift` as A returns it, as B returns null; open B's register while A's is open → allowed; create "Table 1" in A and in B → both succeed; lists scoped; open-register / create-table on "All Outlets" → 400; close/update/delete another outlet's shift/table by id → 404.
- [ ] Commits remain LOCAL — push only on explicit user instruction.

## Notes for B3–B5

Same recipe: add nullable `outletId` → backfill → stamp via `resolveCreateOutlet` → filter via `resolveOutletScope` → by-id guard `if (scope && row.outletId !== scope) throw notFound`. The `@@unique([outletId, number])` + scoped existence check is the template for any per-outlet human-assigned identifier. Next: B3 Expense, B4 Procurement, B5 Delivery.
