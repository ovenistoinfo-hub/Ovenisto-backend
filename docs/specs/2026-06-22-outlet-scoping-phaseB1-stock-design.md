# Outlet Scoping — Phase B1 (Stock & Production) — Design Spec

**Date:** 2026-06-22
**Status:** Approved (design); pending spec review → writing-plans
**Author:** Brainstorm session (Hamza + Claude)
**Builds on:** Phase A (`resolveOutletScope`, `X-Outlet-Id` header, `OutletContext`) — see
`docs/specs/2026-06-20-outlet-scoping-phaseA-design.md`.

---

## Problem

Phase A made the app outlet-aware and enforced scope on the entities that already had an
`outletId` column (Orders, Warehouses, Reports, Dashboard). The ~15 transactional models that
**lack** an `outletId` column are still chain-wide: a non-super-admin sees every branch's stock
adjustments, productions, stock-takes, transfers, and waste. Phase B closes that, domain by domain.

**Phase B1 = Stock & Production** — the first and highest-impact slice (inventory operations are
per-branch and tie into the dough lifecycle). Five models:
`StockAdjustment`, `StockTake`, `Production`, `Transfer`, `WasteRecord`.

### Decisions already made (brainstorming)
- **Sub-phasing:** Phase B is split by domain; B1 is Stock & Production. Later: B2 Cash/Shifts +
  Tables, B3 Expenses, B4 Procurement, B5 Delivery. Each its own spec → plan → deploy.
- **Customer & Supplier are chain-wide (shared)** — NOT scoped in any Phase B sub-phase.
- **Not-yet-built modules** (Loyalty, Deals, Coupons, Reservations, Attendance/HR, Reports) are
  excluded — they will be born outlet-aware when built.
- **Backfill:** derive from warehouse where possible; everything else → "Ovenisto Main Branch".
- **New StockAdjustment/StockTake** stamp outlet from the **warehouse's outlet** (warehouse is
  where the stock physically is); `warehouseId`-null → the acting user's scope.

---

## Goals (B1)

1. Add a nullable `outletId` to `StockAdjustment`, `StockTake`, `Production`, `WasteRecord`.
2. `Transfer` is scoped via its existing `fromOutletId`/`toOutletId` (no new column).
3. Stamp `outletId` on create via a small `resolveCreateOutlet` helper (warehouse outlet, else
   acting user's scope; block a Super-Admin-on-"All" with 400).
4. Filter all six list endpoints by `resolveOutletScope` (Transfer uses an OR over from/to).
5. Backfill existing rows (one-time idempotent seed script).
6. No frontend changes required — the stock pages already carry `X-Outlet-Id` and refetch on
   outlet-switch (Phase A plumbing).

## Non-Goals (B1)

- Customer, Supplier, Expense, Shift, Tables, Procurement, Delivery (later sub-phases).
- Any model whose API/UI is not yet built.
- Adding `outletId` to `StockBatch`/`WarehouseStock` — they already derive outlet from their
  `Warehouse` (which has `outletId`); their reads are scoped via the warehouse relation
  (e.g. `getDoughBatches` already does `warehouse: { outletId }`).
- Parent-derived child rows (`StockTakeItem`) get no column — they belong to their parent.
- Changing the Phase A header selector or `resolveOutletScope` itself.

---

## Architecture

### Schema changes (Neon, via `prisma db push` — nullable column, non-destructive)

Add to each of `StockAdjustment`, `StockTake`, `Production`, `WasteRecord`:
```prisma
  outletId  String?
  outlet    Outlet?  @relation(fields: [outletId], references: [id])
  // plus: @@index([outletId])
```
Add the matching back-relations on the `Outlet` model (Prisma requires them), e.g.:
```prisma
  stockAdjustments StockAdjustment[]
  stockTakes       StockTake[]
  productions      Production[]
  wasteRecords     WasteRecord[]
```
`Transfer`: **no schema change** (already has `fromOutletId`/`toOutletId`). `StockBatch`,
`WarehouseStock`, `StockTakeItem`: **no change**.

Column stays **nullable** (matches `Order.outletId`; null = "unassigned" — only reachable now if a
Super-Admin create were allowed through, which the create-guard prevents).

### Create-time stamping — helper `resolveCreateOutlet`

New helper (e.g. `src/middleware/outletScope.ts`, alongside `resolveOutletScope`):

```ts
// Returns the outlet id to stamp on a new row, or throws 400 if it can't be determined.
//   warehouseOutletId given  → use it (the stock's physical outlet)
//   else                     → use resolveOutletScope(req)
//   if that is null AND the user is Super Admin (on "All") → throw 400 (must pick an outlet)
//   (a non-super-admin always resolves to their own outlet)
export function resolveCreateOutlet(req: Request, warehouseOutletId?: string | null): string {
  if (warehouseOutletId) return warehouseOutletId;
  const scope = resolveOutletScope(req);
  if (scope) return scope;
  throw ApiError.badRequest('Select a specific outlet before creating');
}
```
> The throw only fires for a Super Admin on "All" with no warehouse to derive from. A
> non-super-admin's `resolveOutletScope` is always their own `outletId` (never null unless they
> have no assigned outlet — the documented pre-existing edge, unchanged).

Applied on create:
- **StockAdjustment** (`createAdjustment`): if `warehouseId` present, look up that warehouse's
  `outletId` and pass it; else pass undefined → user scope. Stamp `outletId`.
- **StockTake** (`startStockTake`): same as adjustment (it has `warehouseId`).
- **Production** (`createProduction`): no warehouse on the record → `resolveCreateOutlet(req)`
  (user scope). (The dough Path-B already resolves a kitchen warehouse from the user's outlet, so
  the stamped `outletId` and the batch's warehouse outlet agree.)
- **WasteRecord**:
  - manual `createWasteRecord` → `resolveCreateOutlet(req)` (user scope).
  - dough `wasteDoughBatch` → derive from the batch's warehouse outlet and stamp it (so an
    expired-dough waste is attributed to the kitchen's outlet, consistent with the batch).
- **Transfer** (`createTransfer`): already records `fromOutletId`/`toOutletId` from the request —
  unchanged, no `resolveCreateOutlet` needed.

### Read filtering

Apply `const scope = resolveOutletScope(req)` and:
- `getAdjustments`, `getStockTakes`, `getProductions`, `getWasteRecords`:
  `if (scope) where.outletId = scope;`
- `getTransfers` (special — a transfer involves two outlets):
  `if (scope) where.OR = [{ fromOutletId: scope }, { toOutletId: scope }];`
- `getDoughBatches`: already filters `warehouse: { outletId }` — **leave as-is**.

### Frontend

No code changes. The stock pages (`Production`, `Waste`, `StockAdjustments`, `StockTakes`,
`Transfers`) call `stockService` which goes through `api.ts` → already sends `X-Outlet-Id`, and the
Phase A `OutletContext.setSelectedOutletId` calls `api.clearCache()` + `queryClient.invalidateQueries()`
on switch, so these lists refetch with the new outlet automatically. The only behavioral change a
user sees: a Super Admin on "All Outlets" who tries to create a production/adjustment/waste/stock-take
gets the Phase A-style 400 toast ("Select a specific outlet before creating") and must pick an outlet
first. (A nicer pre-emptive disable is a possible later polish; the 400 is the hard guarantee.)

---

## Data Flow (create)

```
POST /api/stock/productions (or /adjustments, /takes, /waste)
  └─ resolveCreateOutlet(req, warehouseOutletId?)
       ├─ warehouse outlet known → stamp it
       ├─ else scope = resolveOutletScope(req)
       │        ├─ non-admin → their outletId  → stamp
       │        └─ Super Admin "All" (null)    → 400 "Select a specific outlet before creating"
       └─ row created with outletId

GET list → where.outletId = resolveOutletScope(req)  (Transfer: OR from/to)
```

---

## Backfill / Migration

**Migration:** the nullable `outletId` column is added by `prisma db push`, which Railway already
runs on boot (`scripts/db-push.mjs` in the start command). No manual migration step; no data loss.

**Backfill seed script** `src/seeds/outletStockBackfill.ts`, exposed as
`npm run db:seed-outlet-stock`. Idempotent — only updates rows where `outletId IS NULL`:
- `StockAdjustment`: set `outletId` = the row's `warehouse.outletId` where `warehouseId` is set
  and the warehouse has an outlet; remaining rows → the "Ovenisto Main Branch" outlet id.
- `StockTake`: same rule (has `warehouseId`).
- `Production`: all NULL rows → "Ovenisto Main Branch".
- `WasteRecord`: all NULL rows → "Ovenisto Main Branch".
- The "Ovenisto Main Branch" outlet is looked up by name; if it is missing the script aborts with a
  clear error (do not guess).
- Logs a per-model count of rows updated and a final count of any rows still NULL (should be 0).

**Run once after deploy** (same operational pattern as the existing `db:seed-warehouses`).

---

## Error Handling

- **Create with undeterminable outlet** (Super Admin on "All", no warehouse): `400 Bad Request`,
  message exactly `Select a specific outlet before creating`. Surfaced as a toast by the existing
  stock pages.
- **Warehouse with a null outlet** (e.g. a shared MAIN warehouse): `resolveCreateOutlet` treats a
  null `warehouseOutletId` as "not given" and falls back to the user's scope — so it never stamps a
  meaningless value.
- **Non-super-admin with no `outletId`** (pre-existing data edge): `resolveOutletScope` returns
  null → `resolveCreateOutlet` would throw. This matches the principle that you cannot create
  outlet-owned data with no outlet; in practice all real staff have an outlet. Documented, unchanged
  from Phase A's stance.

---

## Testing

**Backend unit (vitest) — `resolveCreateOutlet`:**
- warehouse outlet `"o1"` given → returns `"o1"` (ignores scope).
- no warehouse, Manager scope `"o2"` → returns `"o2"`.
- no warehouse, Super Admin "All" (scope null) → throws 400 with the exact message.
- no warehouse, Super Admin header `"o3"` → returns `"o3"`.

**Backend live verify (after deploy + backfill):**
- As Super Admin scoped to outlet A: create a production, an adjustment (in A's warehouse), a waste,
  a stock-take → each appears in A's scoped list and NOT in B's.
- Create any of them while on "All Outlets" → 400.
- Create a Transfer A→B → it appears in BOTH A's and B's transfer lists (OR filter).
- Backfill: after running `db:seed-outlet-stock`, query each table for `outletId IS NULL` → 0 rows;
  spot-check that warehouse-linked adjustments got the warehouse's outlet.

**Frontend:** manual smoke — switching the header outlet changes the Production/Waste/Adjustments/
StockTakes/Transfers lists (no code change, but confirm the Phase A refetch path covers them).

---

## Files (B1)

**Backend:**
- Modify: `prisma/schema.prisma` (add `outletId` + relation to 4 models + Outlet back-relations + indexes)
- Modify: `src/middleware/outletScope.ts` (add `resolveCreateOutlet`) + `__tests__/outletScope.test.ts` (new cases)
- Modify: `src/modules/stock/stock.controller.ts` (stamp on create: createAdjustment, startStockTake,
  createProduction, createWasteRecord, wasteDoughBatch; filter on read: getAdjustments, getStockTakes,
  getProductions, getWasteRecords, getTransfers)
- Create: `src/seeds/outletStockBackfill.ts`; add `db:seed-outlet-stock` script to `package.json`

**Frontend:** none.

---

## Reuse / Next

This establishes the Phase B pattern: add nullable `outletId` → backfill → stamp via
`resolveCreateOutlet` → filter via `resolveOutletScope`. B2–B5 apply the same recipe to their
modules (Shifts/Tables, Expenses, Procurement, Delivery). `Transfer`'s OR-filter is the template for
any future two-outlet entity.
