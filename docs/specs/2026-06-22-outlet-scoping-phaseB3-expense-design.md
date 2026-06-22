# Outlet Scoping — Phase B3 (Expense) — Design Spec

**Date:** 2026-06-22
**Status:** Approved (design); pending spec review → writing-plans
**Author:** Brainstorm session (Hamza + Claude)
**Builds on:** Phase A (`resolveOutletScope`, `X-Outlet-Id`, `OutletContext`), B1
(`resolveCreateOutlet`, the add-column → backfill → stamp → filter recipe + the dashboard
waste-scoping fix), B2 (the by-id guard pattern + the route-auth lesson). See the B1/B2 specs.

---

## Problem

Phase B is outlet-scoping the transactional domains one at a time. **B3 = Expense.** Today expenses
are chain-wide: every branch sees every branch's expenses, and — more importantly — the P&L report
and the Dashboard subtract **all** branches' expenses from a single branch's revenue, so a scoped
**net profit is wrong**. (B1 explicitly deferred this: it scoped waste but left the expense
aggregations restaurant-wide because `Expense` had no `outletId`.) B3 adds the column and finishes
the net-profit story.

### Decisions already made (brainstorming)
- **Backfill:** all existing expenses → "Ovenisto Main Branch". `Expense.recordedBy` is a free-text
  name (VarChar), not a `userId` FK, so there is no reliable link to derive an outlet from.
- **Scope the reports too:** the P&L report and Dashboard expense aggregations become per-outlet
  (this is the point of B3 — correct per-branch net profit).
- Customer/Supplier stay chain-wide (out of all Phase B). Not-yet-built modules excluded.

---

## Goals (B3)

1. Add nullable `outletId` to `Expense` (+ Outlet back-relation + index).
2. Scope `getExpenses`; stamp `createExpense`; by-id guards on `getExpense`, `updateExpense`,
   `deleteExpense`.
3. Scope the expense aggregation in `getPnlReport` and `getDashboard` by outlet; retire the
   `expensesAreRestaurantWide` workaround flag (set it `false`).
4. Backfill existing rows (one-time idempotent seed) → "Ovenisto Main Branch".
5. No frontend changes.

## Non-Goals (B3)

- Procurement, Delivery (later sub-phases B4–B5).
- Customer/Supplier (chain-wide).
- Changing how `recordedBy` is stored (still a name string).
- Any per-category or per-payment-method scoping beyond the outlet filter.

---

## Architecture

### Schema (Neon, `prisma db push` — non-destructive)

`Expense` — add:
```prisma
  outletId      String?
  outlet        Outlet?  @relation(fields: [outletId], references: [id])
  // + @@index([outletId])
```
`Outlet` — add back-relation:
```prisma
  expenses Expense[]
```
Column nullable (matches the rest of the outlet columns). No constraint changes.

### Expense controller (`src/modules/expenses/expense.controller.ts`)

All five routes already carry `authenticate` (verified: `expense.routes.ts` — `GET /`, `GET /:id`,
`POST /`, `PUT /:id`, `DELETE /:id` all authenticated), so `req.user` is always populated and the
B2 route-auth gap does not apply here. Reuse `resolveOutletScope` / `resolveCreateOutlet`.

- **`getExpenses`** — `const scope = resolveOutletScope(req); if (scope) where.outletId = scope;`
- **`getExpense`** (by-id) — after the existing not-found check:
  `const scope = resolveOutletScope(req); if (scope && expense.outletId !== scope) throw ApiError.notFound('Expense not found');`
- **`createExpense`** — `const outletId = resolveCreateOutlet(req);` (400s a Super-Admin-on-"All")
  and stamp `outletId` in the create `data`.
- **`updateExpense`** / **`deleteExpense`** (by-id) — same guard as `getExpense`, after the
  not-found check, before the update/delete.

### Reports (the headline — per-outlet net profit)

`src/modules/reports/reports.controller.ts`. In both handlers, `outletId` is already the resolved
scope (Phase A/B1 routed `getParams` and `getDashboard` through `resolveOutletScope`).

- **`getPnlReport`** (around line 110-126): scope the expense query and retire the flag:
  ```ts
  const expenseRows = await prisma.expense.findMany({
    where: { ...(outletId ? { outletId } : {}), date: { gte, lte } },
    select: { amount: true, category: true },
  });
  // ...
  const expensesAreRestaurantWide = false;   // expenses are now outlet-scoped
  ```
  (Keep the `expensesAreRestaurantWide` key in the response so the frontend P&L tab's contract is
  unchanged; it now reports `false`, so the "restaurant-wide" caveat the UI showed simply
  disappears.)
- **`getDashboard`** (around line 270-272): add the existing `outletFilter` to the expense query and
  update the comment (mirrors B1's waste-scoping fix):
  ```ts
  // --- expenses + waste this month (both outlet-scoped) ---
  prisma.expense.findMany({ where: { ...outletFilter, date: { gte: mb.thisStart, lte: mb.thisEnd } }, select: { amount: true } }),
  ```

### Frontend

No code changes. The Expense page calls `expenseService` → `api.ts` (sends `X-Outlet-Id`, refetches
on outlet switch). The Reports P&L tab reads `expensesAreRestaurantWide`; it now receives `false`, so
its restaurant-wide caveat note disappears — the desired UX (expenses are now properly per-branch).

---

## Data Flow

```
POST /api/expenses         → resolveCreateOutlet(req) → outletId (or 400 on "All") → stamped
GET /api/expenses          → where.outletId = resolveOutletScope(req)
GET/PUT/DELETE /:id        → if (scope && row.outletId !== scope) → 404
P&L / Dashboard expenses   → where.outletId = (resolved scope) → per-outlet net profit
```

---

## Error Handling

- **Create on "All" (Super Admin):** `400` — `Select a specific outlet before creating`.
- **By-id cross-outlet (get/update/delete):** `404` — exact message `Expense not found` (no 403; don't
  leak existence).
- **Non-super-admin with no `outletId`:** `resolveCreateOutlet` throws 400 — documented edge,
  unchanged from earlier phases.

---

## Backfill / Migration

**Migration:** the nullable `outletId` column is added by `prisma db push` (Railway runs it on boot).
Non-destructive.

**Backfill seed** `src/seeds/outletExpenseBackfill.ts` (`npm run db:seed-outlet-expense`), idempotent —
only `outletId IS NULL` rows → "Ovenisto Main Branch" (looked up by name; abort if missing; throw if
any row remains NULL after; log the count). Run once after deploy (same pattern as the prior backfills).

---

## Testing

**Backend:** `npm run typecheck` (0) and `npm run test` (the existing 47 tests still pass — B3 adds no
new pure helper; it reuses B1's tested `resolveCreateOutlet`/`resolveOutletScope`).

**Backend live verify (after deploy + backfill):**
- As Super Admin scoped to outlet A: create an expense → it appears in A's list, NOT in B's.
- Create on "All Outlets" → 400.
- Get/update/delete another outlet's expense by id → 404.
- P&L report and Dashboard for outlet A show only A's expenses → A's net profit differs from the
  all-outlets net profit (no longer subtracting every branch's expenses).
- Backfill: after `db:seed-outlet-expense`, no `outletId IS NULL` expenses remain.

**Frontend:** manual smoke — switching the header outlet changes the Expenses page and the
Reports/Dashboard net profit.

---

## Files (B3)

**Backend:**
- Modify: `prisma/schema.prisma` (Expense + outletId/relation/index; Outlet back-relation)
- Modify: `src/modules/expenses/expense.controller.ts` (5 handlers: list scope, create stamp, 3 by-id guards)
- Modify: `src/modules/reports/reports.controller.ts` (getPnlReport expense scope + flag; getDashboard expense scope)
- Create: `src/seeds/outletExpenseBackfill.ts`; add `db:seed-outlet-expense` to `package.json`

**Frontend:** none.

---

## Reuse / Next

B3 is the B-phase recipe applied to one clean CRUD module plus the matching report-aggregation
scoping. With B3 the Dashboard/P&L net profit is fully per-outlet (revenue, COGS, waste, AND
expenses). Remaining: B4 Procurement (Purchase/PurchaseRequest/StockChallan/StockDemand), B5 Delivery
(DeliveryRider/DeliveryAssignment).
