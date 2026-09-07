> Status: approved 2026-09-07. Mirrored byte-for-byte in both sub-repos so a repo-scoped
> Claude Code session can read it:
> `Ovenisto-backend/docs/plans/2026-09-07-dashboard-analytics-merge.md` and
> `Ovenisto_Frontend_Software/docs/superpowers/plans/2026-09-07-dashboard-analytics-merge.md`.

# Dashboard + Analytics Redesign

## Context

You said most of the software is finished and the Dashboard is the last piece to finalize — the
current one is "very basic," and you asked whether Dashboard and Analytics can be combined before
designing the real thing.

Research confirms the merge is the right call, not just a nice-to-have: `Dashboard.tsx` and
`Analytics.tsx` already call the **exact same backend endpoint** (`GET /reports/dashboard`).
Analytics doesn't have its own backend logic — it re-derives most of its charts **client-side** by
pulling up to 1000 raw orders and recomputing peak hours, day-of-week performance, customer
activity, etc. in the browser, duplicating work the backend already has helpers for. The backend's
`analytics` route mount is commented out with zero files behind it — a dead placeholder, nothing to
preserve there.

The current Dashboard's real problem, concretely: **377 lines, ~20 cards, one chart, and not a
single clickable element anywhere** (no `onClick`, no `<Link>`, checked directly in the file). It
surfaces data from only 2 of the app's ~35 backend service modules. Two response fields
(`topItems`, `topCustomers`, `payable`, `receivable`) are already fetched and silently discarded —
never rendered.

**Your three confirmed decisions this plan is built around:**
1. Clicking a tile navigates to that module's real existing page (not a modal).
2. Keep today's role visibility — Super Admin, Admin, Manager, Floor Manager, Cashier. No wider rollout.
3. Must work well on both desktop and the POS tablet (touch-first).

## The decision: merge into one page, retire `/analytics`

Fold Analytics' worthwhile charts (Peak Hours, Customer Activity, Order Type Trend, Day-of-Week
Performance, Top 10 Customers) into the Dashboard, computed **server-side** by extending
`GET /reports/dashboard`, then delete the `/analytics` route/nav/permission entirely.
`Reports.tsx` (`/reports`, 8-tab tabular deep-dive) is untouched — different job, stays separate.

Confirmed safe: only **Manager** has an explicit `"analytics"` permission string among the 5
target roles (Super Admin/Admin have `["*"]`, Floor Manager and Cashier never had it) — verified
directly in `AuthContext.tsx`.

## Information Architecture

Same page shell as today (`PageHeader` + `OutletFilterSelect`), then zones as section headers —
a zone renders only if it has ≥1 tile visible to the current role (same `.length === 0 → null`
idiom `AppSidebar.tsx` already uses).

| Zone | Tile | Click → route | Gating module | Data source |
|---|---|---|---|---|
| **Today's Operations** | Live Orders (pending/preparing/ready) | `/order-status` | `order-status` | NEW: order status counts, today |
| | Kitchens (reuses preparing count) | `/kitchens` | `kitchens` | same field, no extra query |
| | Tables (occupied/available) | `/table-layout` | `table-layout` | NEW: table status counts |
| | Cancellation Requests (pending) | `/cancellation-requests` | `cancellation-requests` | reuse the same react-query key `AppSidebar.tsx` already fires — cache-shared, zero extra request |
| **Sales & Finance** | Day-wise chart, channel cards, growth, financial overview | (unchanged visuals) | `dashboard` | unchanged existing fields |
| | Top 10 Items (currently dead data) | → `/reports` | `reports` | existing `topItems`, finally rendered |
| | Payment Methods breakdown | → `/cash-hub` | `cash-hub` | existing `month.paymentBreakdown` |
| **Inventory & Procurement** | Dough/Short-Life Batches | inline Waste action (unchanged) | `warehouses` | unchanged, only interactive widget stays as-is |
| | Low Stock Alert | `/warehouses`; **Super Admin → `/warehouse-dashboard`** | `warehouses` (SA: `warehouse-dashboard`) | NEW — see correction below, this must go through `WarehouseStock`, not global `Ingredient` |
| | Pending Purchase Requests | `/purchase-requests` | `purchase-requests` | NEW: count |
| | Pending Demands | `/demands` | `demands` | NEW: count |
| **People** | Today's Attendance (present/late/absent) | `/attendance` | `attendance` | NEW: PKT-aware "today" |
| | Pending Leave Requests | `/attendance` | `attendance` | NEW: count |
| **Customer Intelligence** | Top 10 Customers (row click) | `/customers/:id` | `customers` | existing `topCustomers` + add `customerId` (currently dropped) |
| | Peak Hours / Customer Activity / Order Type Trend / Day-of-Week charts | header link → `/reports` or `/customers` | `customers`/`sales` | NEW, server-computed (ported from Analytics.tsx) |
| **Delivery** | Active Deliveries | `/delivery` | `delivery` | NEW: lightweight count, not the heavy delivery-dashboard endpoint |
| **Reservations** | Today's Reservations | `/reservations` | `customers` | NEW: count, real `DateTime` day-range |
| **Cash Hub** | Unsettled Cash (total + staff count) | `/cash-hub` | `cash-hub` | NEW: reuse `cash-settlement.service.ts`'s existing `getActiveBalances()` — don't re-derive the math |

Deliberately NOT duplicated into the dashboard as full data: Sales, Branch Stock, and the 8-tab
Reports page stay deep-dive destinations only. The dashboard is a summary + launchpad, not a
second Reports page. **Payable/Receivable is deliberately excluded too** (per your review
comment) — that per-warehouse "who owes what" detail already lives on `WarehouseDashboard.tsx`;
this Dashboard is the chain-wide combined view, so it doesn't need its own copy of the same
figures. The `payable`/`receivable` fields stay in the `/reports/dashboard` response (harmless,
already computed) but the frontend simply never renders them here.

## Data strategy: extend the existing endpoint, don't add a second one

`GET /reports/dashboard` (`Ovenisto-backend/src/modules/reports/reports.controller.ts`) already
does exactly this job — one outlet-scoped call. Adding fields there keeps the merged page at
**2 total requests** (`/reports/dashboard` + the unchanged `stockService.getDoughBatches`, which
keeps its existing 30s `useVisiblePolling` safety net — the one legitimately live widget). That's
fewer requests than today's *separate* Dashboard+Analytics combined (3, one of which pulls 1000
rows). A second new endpoint would only add a round-trip for no reason — reject that option.

New Prisma work, all small `count`/`groupBy` calls plus one bounded `findMany`, added alongside the
endpoint's existing queries:

| Field | Query | Notes |
|---|---|---|
| `today.liveStatus` | `Order.groupBy({by:['status']})`, today, outlet-scoped | reuse the endpoint's existing `dayBoundaries(now)` for the range |
| `tables` | `RestaurantTable.groupBy({by:['status']})`, outlet-scoped via `outletId` (nullable, optional-filter pattern) | |
| **`lowStockCount`** | **`WarehouseStock.findMany({ where: { ...(scope ? { warehouse: { outletId: scope } } : {}) }, select: { currentStock, lowStockLevel } })`, then filter `currentStock <= lowStockLevel` in JS** | **Correction from the draft plan** — do NOT filter the global `Ingredient` table by `outletId`. Per this repo's own CLAUDE.md, `Ingredient` is a **chain-wide catalog**; virtually every row has `outletId: null` (confirmed in `schema.prisma`). Filtering it by outlet would return ~zero ingredients for every branch role, making the tile silently empty. `getStockReport`'s existing low-stock number is *also* chain-wide-only by explicit design (its own code comment says so) — extracting its predicate alone doesn't fix scoping. The correct branch-scoped source is `WarehouseStock` (`warehouseId → Warehouse.outletId`), the same table Kitchen Stock/Branch Stock pages already use. |
| `pendingPurchaseRequests` | `PurchaseRequest.count({ where: { status: 'PENDING', ...(scope ? { warehouse: { outletId: scope } } : {}) } })` | relation name `warehouse` confirmed correct |
| `pendingDemands` | `StockDemand.count({ where: { status: 'PENDING', ...(scope ? { requestingWH: { outletId: scope } } : {}) } })` | **Correction:** the relation is named `requestingWH`, not `requestingWarehouse` — verified in `schema.prisma`. `status` is the `DemandStatus` enum, member name `PENDING`. |
| `attendanceToday` | `AttendanceRecord.groupBy({by:['status']})` where `date === todayStr`, `outletId: scope` (required column, no optional-filter needed *unless* scope is null for Super Admin "all") | **Correction:** `AttendanceRecord.date` is a **string** `"YYYY-MM-DD"`, not a `DateTime` — do NOT reuse `dayBoundaries()`'s `{gte,lte}` range here. Compute `todayStr` with this repo's documented PKT pattern: `new Date(Date.now() + 5*60*60*1000).toISOString().split('T')[0]`. Getting this wrong reproduces exactly the bug class root `CLAUDE.md`'s "PKT Timezone Pattern" section exists to prevent (today reads as yesterday/tomorrow between 19:00–24:00 PKT). |
| `pendingLeaveRequests` | `LeaveRequest.count({ where: { status: 'pending', ...(scope ? { outletId: scope } : {}) } })` | no date filter needed — pending stays pending until reviewed |
| `reservationsToday` | `Reservation.count({ where: { date: { gte: day.gte, lte: day.lte }, status: { in: ['pending','confirmed'] }, ...(scope ? { outletId: scope } : {}) } })` | `Reservation.date` **is** a real `DateTime @db.Date` column (unlike Attendance/Leave) — reuse the endpoint's existing `dayBoundaries(now)` range here, don't string-compare |
| `deliveryActive` | `DeliveryAssignment.count({ where: { status: { in: ['pending','accepted','dispatched'] }, order: { status: { not: 'CANCELLED' }, ...(scope ? { outletId: scope } : {}) } } })` | deliberately NOT the heavy `getDeliveryDashboard` endpoint (eager-loads full order+rider detail) |
| `cashHub` | `getActiveBalances(scope ?? null)` from `cash-settlement.service.ts`, reduced to `{ totalUnsettled, staffCount }` | it's already a plain exported function, not a route handler — call it directly, don't re-derive the settlement math |
| `topCustomers[].customerId` | add to the existing mapped output | already computed as the dedup key, just currently stripped before response |

**Ported Analytics charts — reuse the query the endpoint already runs wherever possible:**
- `daywiseSales` (existing) **replaces** Analytics' separate "Last 7 Days" chart outright — same week, no need for two versions.
- `peakHours`, `orderTypeTrend`, `customerActivity` — all derivable from the **same week-of-orders `findMany`** already run for `daywiseSales`, by widening its `select` to include `type`/`customerId`/`customerName`/`phone` and grouping differently in JS. Zero new queries.
- `dayOfWeekPerformance` — the one genuinely new query: bounded `Order.findMany` over the last 60 days (not "all orders" the way `Analytics.tsx` does it today), grouped by weekday in JS.

**Frontend consequence:** `report.service.ts`'s `DashboardReport` interface changes shape — bump
`App.tsx`'s `PersistQueryClientProvider` `buster` string so a stale persisted cache can't crash the
page before revalidating (documented pattern in this repo's own CLAUDE.md).

## Role-aware rendering: one config, filtered once

```ts
interface DashboardTile {
  id: string;
  zone: "operations" | "sales" | "inventory" | "people" | "intelligence" | "delivery" | "reservations" | "cashHub";
  module: string;                 // hasPermission() key
  title: string;
  icon: LucideIcon;
  route: string;
  superAdminRoute?: { module: string; route: string }; // chain-wide override, only Inventory needs it today
}
```

`DASHBOARD_TILES.filter(t => hasPermission(t.module))`, grouped by zone, zone header renders only
if its group is non-empty — the exact idiom `AppSidebar.tsx` already applies to `navSections`, so
there's no new authorization concept to introduce or separately audit. `hasPermission()` (not the
backend's dead `authorize.ts` map) is the real gate — confirmed only route middleware
(`authorize()` with a role array) is actually wired server-side; `requirePermission` is unused.
Because `hasPermission()` already encodes the Super-Admin branch-terminal exclusion list
(`pos`, `kitchens`, `waiter`, `table-layout`, `cash-hub`, etc.), most tiles need zero Super-Admin
special-casing — they just won't pass the filter for that role. Only Inventory needs the
`superAdminRoute` override (`warehouses` → `warehouse-dashboard`).

Every tile is a whole-`Card` tap target (`onClick={() => navigate(tile.route)}`), not a link buried
in text — matches `POS.tsx`'s existing menu-card hover/press classes
(`hover:shadow-xl hover:border-primary/40 hover:-translate-y-0.5 active:scale-[0.99]`), which
already work on both mouse and touch. Add a small muted `ChevronRight` as the one new visual
affordance clickable cards get, so a user can tell which cards navigate vs. which are pure display
(growth %, payment breakdown bars stay non-interactive, no chevron). Stay inside the existing
"three colours" convention — `primary` for the hover/press state only, `destructive` only for a
genuine problem count (non-zero low-stock / pending-approval badge), everything else neutral. No
page-root `max-w-*` wrapper, matching every other page.

## Migration: retiring `/analytics`

Grep-confirmed exhaustive list of references — nothing else touches `"analytics"`:

**Frontend** (do after the chart port-in above is verified, so nothing loses its home mid-migration):
1. `App.tsx` — remove the `Analytics` lazy import and its `<Route>`.
2. `AppSidebar.tsx` — remove the `{ title: "Analytics", ... module: "analytics" }` nav entry.
3. `AppHeader.tsx` — remove the `/analytics` breadcrumb entry.
4. `AuthContext.tsx` — remove `"analytics"` from Manager's permission array (only role that has it).
5. Delete `src/pages/Analytics.tsx`.

**Backend** (independent, pure dead-code removal — nothing calls `requirePermission('analytics')`):
6. `authorize.ts` — remove `"analytics"` from Manager's list.
7. `routes/index.ts` — remove the commented `/analytics` mount line and the `/api/analytics`
   entry from the discovery JSON (currently advertises a route that doesn't exist).

Verify with `grep -ri analytics` across both repos → zero hits.

## Phased build order

**Phase 1 — Backend aggregation only** (`Ovenisto-backend`, no frontend-visible change)
Extend `getDashboard` with every field above (using the corrected queries); add `customerId` to
`topCustomers`; update `report.service.ts`'s `DashboardReport` type; bump the query-cache `buster`.
*Verify:* `npm run typecheck`; hit `GET /api/reports/dashboard` on a dev server and inspect the
shape; add a colocated unit test for the extracted low-stock predicate (matches this repo's
existing pure-helper-test convention in `reports/__tests__/`).

**Phase 2 — Dashboard shell: tile config + role filter + click-through on data already trusted**
Introduce `DASHBOARD_TILES`; rewrite the Sales & Finance zone to use it, making every existing card
clickable and rendering the previously-dead `topItems` (payable/receivable deliberately excluded —
see Information Architecture above). Dough-batch widget untouched. This phase proves the architecture on data the team already trusts, before layering in
new domains. *Verify:* frontend `npm run typecheck`; manual click-through as each of the 5 roles,
confirming no tile lands on a `ProtectedRoute` bounce.

**Phase 3 — Port Analytics charts server-side, retire `/analytics`**
Add the Customer Intelligence zone from Phase 1's new fields; delete the 1000-order client pull;
execute all 7 retirement steps above. *Verify:* typecheck both repos; `grep -ri analytics` → 0
hits; confirm Manager sees the merged zone where the old nav item used to be.

**Phase 4 — New operational tiles for previously-unsurfaced modules**
Wire up Operations/Inventory/People/Delivery/Reservations/Cash Hub zones; implement the
Super-Admin Inventory override. *Verify:* frontend typecheck; log in as each of the 5 roles and
cross-check visible zones against their actual `rolePermissions` (e.g. Cashier should see only
Sales & Finance; Floor Manager should see Operations/Reservations/Cash Hub but not
People/Inventory/Delivery); confirm every tile's click-through lands on a live, non-404 page.

Each phase ships independently. Phase 1 has zero frontend effect. A slipped later phase never
breaks an earlier one — an unwired zone from a not-yet-consumed field just doesn't render.

## Critical files
- `Ovenisto-backend/src/modules/reports/reports.controller.ts` — `getDashboard`, extend here
- `Ovenisto-backend/src/modules/reports/reports.helpers.ts` — reusable aggregation primitives
- `Ovenisto-backend/src/modules/cash-settlement/cash-settlement.service.ts` — `getActiveBalances()` to reuse
- `Ovenisto-backend/prisma/schema.prisma` — `WarehouseStock`/`Warehouse`, `PurchaseRequest`, `StockDemand`, `AttendanceRecord`, `LeaveRequest`, `Reservation`, `DeliveryAssignment`, `RestaurantTable` models referenced above
- `Ovenisto_Frontend_Software/src/pages/Dashboard.tsx` — rewrite target
- `Ovenisto_Frontend_Software/src/pages/Analytics.tsx` — chart logic to port in, then delete
- `Ovenisto_Frontend_Software/src/services/report.service.ts` — `DashboardReport` type
- `Ovenisto_Frontend_Software/src/contexts/AuthContext.tsx` — `hasPermission`, `rolePermissions`
- `Ovenisto_Frontend_Software/src/App.tsx`, `src/components/layout/AppSidebar.tsx`, `src/components/layout/AppHeader.tsx` — route/nav/breadcrumb removal

## Verification (end-to-end)
- `npm run typecheck` in both repos after every phase (the real correctness gate here; both repos
  carry a large pre-existing lint baseline that isn't the signal to watch).
- Manual pass as each of the 5 target roles (Super Admin, Admin, Manager, Floor Manager, Cashier):
  confirm the zones/tiles they see match their `rolePermissions`, and every visible tile's click
  navigates to a real, non-404 page.
- `grep -ri analytics` across both repos after Phase 3 → zero hits.
- Spot-check `lowStockCount` against `Warehouses.tsx`'s existing branch-stock numbers for a branch
  with known low-stock items — this is the corrected query, worth confirming it actually scopes
  right before trusting the tile.
