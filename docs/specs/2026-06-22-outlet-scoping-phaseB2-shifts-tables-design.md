# Outlet Scoping — Phase B2 (Shifts & Tables) — Design Spec

**Date:** 2026-06-22
**Status:** Approved (design); pending spec review → writing-plans
**Author:** Brainstorm session (Hamza + Claude)
**Builds on:** Phase A (`resolveOutletScope`, `X-Outlet-Id`, `OutletContext`) and Phase B1
(`resolveCreateOutlet`, the add-column → backfill → stamp → filter recipe). See
`docs/specs/2026-06-20-outlet-scoping-phaseA-design.md` and
`docs/specs/2026-06-22-outlet-scoping-phaseB1-stock-design.md`.

---

## Problem

Phase B is outlet-scoping the transactional domains one at a time. **B2 = Cash Register (Shift) +
Floor Tables (RestaurantTable).** Today both are chain-wide: every branch sees every branch's shifts
and tables, only ONE register can be open across the whole chain, and table numbers must be globally
unique so two branches can't both have a "Table 1". B2 makes each branch run its own register and own
its own floor.

### Decisions already made (brainstorming)
- **RestaurantTable.number becomes unique PER OUTLET** (`@@unique([outletId, number])`) — each branch
  has its own numbering; Branch A "Table 1" and Branch B "Table 1" coexist.
- **Shift.shiftNumber stays globally `@unique`** (a global SH-001… sequence; no per-outlet numbering).
- **A register is "already open" PER OUTLET**, not chain-wide; `getActiveShift` returns the caller's
  outlet's open shift.
- **Backfill:** Shift → derive from its cashier's `user.outletId`, else "Ovenisto Main Branch";
  RestaurantTable → all → "Ovenisto Main Branch".
- Customer/Supplier remain chain-wide (out of all Phase B). Not-yet-built modules excluded.

---

## Goals (B2)

1. Add nullable `outletId` to `Shift` and `RestaurantTable` (+ Outlet back-relations + indexes).
2. Change `RestaurantTable.number` from global `@unique` to `@@unique([outletId, number])`.
3. Scope reads: `getShifts`, `getActiveShift`, `getTables`.
4. Stamp `outletId` on create: `createShift`, `createTable` (via `resolveCreateOutlet`).
5. Make per-outlet: the `createShift` "already open" check and `getActiveShift`.
6. Per-outlet uniqueness in `createTable`'s existence check.
7. By-id guards on `closeShift`, `updateTable`, `deleteTable`.
8. Add `authenticate` to `GET /tables` so scoping can see the user.
9. Backfill existing rows (one-time idempotent seed).
10. No frontend changes expected.

## Non-Goals (B2)

- Expense, Procurement, Delivery (later sub-phases B3–B5).
- Reservation (relates to RestaurantTable, but the reservations module is not built — excluded).
- Per-outlet `shiftNumber` numbering (kept global by decision).
- Aggregating a shift's order totals server-side — `closeShift` already receives totals in the
  request body; B2 does not change that.
- Customer/Supplier (chain-wide, never scoped).

---

## Architecture

### Schema changes (Neon, via `prisma db push` — non-destructive)

`Shift` — add:
```prisma
  outletId  String?
  outlet    Outlet?  @relation(fields: [outletId], references: [id])
  // + @@index([outletId])
```

`RestaurantTable` — add the column + relation + index, AND change the uniqueness of `number`:
```prisma
  // was: number  String  @unique @db.VarChar(10)
  number    String   @db.VarChar(10)     // drop the field-level @unique
  outletId  String?
  outlet    Outlet?  @relation(fields: [outletId], references: [id])
  // + @@unique([outletId, number])
  // + @@index([outletId])
```

`Outlet` — add back-relations:
```prisma
  shifts           Shift[]
  restaurantTables RestaurantTable[]
```

**Migration safety:** at boot all existing rows have `outletId = NULL`. The new
`@@unique([outletId, number])` is satisfied because Postgres treats NULLs as distinct and the existing
`number` values were already globally unique — so dropping the old `@unique` and adding the composite
cannot violate. Backfill then sets `outletId`; after it, `(MainBranch, number)` pairs remain unique.
`shiftNumber` keeps its global `@unique`.

### Shift handlers (`src/modules/shifts/shift.controller.ts`)

Reuse `resolveOutletScope(req): string|null` and `resolveCreateOutlet(req, warehouseOutletId?): string`
(no warehouse here, so always the scope form).

- **`getActiveShift`** — currently `findFirst({ where: { status: 'open' } })` with `_req`. Change to
  use `req`, scope to the caller's outlet:
  ```ts
  const scope = resolveOutletScope(req);
  const shift = await prisma.shift.findFirst({ where: { status: 'open', ...(scope ? { outletId: scope } : {}) } });
  ```
  (Non-admin → their outlet's open register. Super Admin on a specific outlet → that outlet's. Super
  Admin on "All" → any open shift / null; acceptable, a Super Admin on "All" is not running a till.)
- **`getShifts`** — `const scope = resolveOutletScope(req); if (scope) where.outletId = scope;`
- **`createShift`** — stamp + make the open-register check per-outlet:
  ```ts
  const outletId = resolveCreateOutlet(req);                     // 400 for Super-Admin-on-"All"
  const existing = await prisma.shift.findFirst({ where: { status: 'open', outletId } });
  if (existing) throw ApiError.badRequest('A shift is already open. Close it before opening a new one.');
  // ...create with outletId stamped
  ```
- **`closeShift`** — by-id guard after the existing not-found check:
  ```ts
  const scope = resolveOutletScope(req);
  if (scope && shift.outletId !== scope) throw ApiError.notFound('Shift not found');
  ```

### Table handlers (`src/modules/tables/table.controller.ts` + `table.routes.ts`)

- **Route:** add `authenticate` to `GET /tables` (it currently has none, so `req.user` is never set and
  scoping cannot work). The table list is staff floor-management, not a public/kiosk endpoint.
- **`getTables`** — `const scope = resolveOutletScope(req); if (scope) where.outletId = scope;`
- **`createTable`** — stamp + per-outlet existence check:
  ```ts
  const outletId = resolveCreateOutlet(req);
  const existing = await prisma.restaurantTable.findFirst({ where: { number: String(number), outletId } });
  if (existing) throw ApiError.badRequest(`Table ${number} already exists`);
  // ...create with outletId stamped
  ```
- **`updateTable`** — by-id guard after its not-found check:
  ```ts
  const scope = resolveOutletScope(req);
  if (scope && table.outletId !== scope) throw ApiError.notFound('Table not found');
  ```
  (load the table first if the handler doesn't already; mirror the existing not-found pattern.)
- **`deleteTable`** — same by-id guard.

### Frontend

No code changes expected. The Shifts and Tables pages call their services through `api.ts`, which
already sends `X-Outlet-Id` (Phase A) and refetches on outlet-switch (`queryClient.invalidateQueries`).
Visible change: a Super Admin on "All Outlets" who opens a register or creates a table gets the 400
toast (must pick an outlet) — consistent with Phase A/B1.

---

## Data Flow

```
POST /api/shifts (open register)         POST /api/tables
  └─ resolveCreateOutlet(req)              └─ resolveCreateOutlet(req)
       → outletId (or 400 on "All")             → outletId (or 400 on "All")
  └─ open-shift check scoped to outletId   └─ existence check scoped to (outletId, number)
  └─ create stamped with outletId          └─ create stamped with outletId

GET list/active → where.outletId = resolveOutletScope(req)
by-id close/update/delete → if (scope && row.outletId !== scope) 404
```

---

## Error Handling

- **Open register / create table on "All" (Super Admin):** `400` — `Select a specific outlet before creating`.
- **Open a second register in the same outlet while one is open:** `400` —
  `A shift is already open. Close it before opening a new one.` (now per-outlet, so a different outlet
  is NOT blocked).
- **Duplicate table number within the same outlet:** `400` — `Table <n> already exists` (a different
  outlet may reuse the number).
- **Close/update/delete another outlet's shift/table:** `404` (not 403 — don't leak existence).
- **Non-super-admin with no `outletId`:** `resolveCreateOutlet` throws 400 — documented edge, unchanged
  from Phase A/B1; in practice all staff have an outlet.

---

## Backfill / Migration

**Migration:** columns + the `RestaurantTable.number` constraint swap apply via `prisma db push`
(Railway runs it on boot). Non-destructive; safe ordering explained under Schema above.

**Backfill seed** `src/seeds/outletShiftTableBackfill.ts`, exposed as `npm run db:seed-outlet-shifttable`.
Idempotent — only `outletId IS NULL` rows:
- `Shift` → derive from the shift's `cashier` (`user.outletId`); cashier null or has no outlet →
  "Ovenisto Main Branch".
- `RestaurantTable` → all → "Ovenisto Main Branch".
- Look up "Ovenisto Main Branch" by name; abort if missing. Log per-model counts (derived vs fallback);
  throw if any row remains NULL after.

**Run once after deploy** (same operational pattern as `db:seed-warehouses` / `db:seed-outlet-stock`).

---

## Testing

**Backend:** `npm run typecheck` (0) and `npm run test` (the existing 47 tests still pass — B2 adds no
new pure helper; it reuses B1's tested `resolveCreateOutlet`/`resolveOutletScope`).

**Backend live verify (after deploy + backfill):**
- Open a register in outlet A → `getActiveShift` as an A user returns it; as a B user returns null (or
  B's own). Open B's register while A's is open → allowed (per-outlet). `getShifts` scoped.
- Create "Table 1" in A and "Table 1" in B → both succeed (per-outlet unique). `getTables` scoped.
- Open register / create table while on "All Outlets" → 400.
- Close/update/delete another outlet's shift/table by id → 404.
- Backfill: after `db:seed-outlet-shifttable`, no `outletId IS NULL` rows remain; spot-check a shift
  got its cashier's outlet.

**Frontend:** manual smoke — switching the header outlet changes the Shifts and Tables pages (no code
change; confirm the Phase A refetch path covers them).

---

## Files (B2)

**Backend:**
- Modify: `prisma/schema.prisma` (Shift + RestaurantTable columns/relations/indexes; RestaurantTable
  `number` uniqueness → composite; Outlet back-relations)
- Modify: `src/modules/shifts/shift.controller.ts` (getActiveShift, getShifts, createShift, closeShift)
- Modify: `src/modules/tables/table.controller.ts` (getTables, createTable, updateTable, deleteTable)
- Modify: `src/modules/tables/table.routes.ts` (add `authenticate` to `GET /`)
- Create: `src/seeds/outletShiftTableBackfill.ts`; add `db:seed-outlet-shifttable` to `package.json`

**Frontend:** none.

---

## Reuse / Next

B2 follows the established B-phase recipe and adds the **per-outlet-uniqueness** template
(`@@unique([outletId, number])` + a scoped existence check) for any future entity with a
human-assigned identifier. Remaining: B3 Expense, B4 Procurement, B5 Delivery.
