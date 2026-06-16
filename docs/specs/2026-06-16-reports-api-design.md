# Reports API — Design Spec (Phase 1: Core 4)

**Date:** 2026-06-16
**Status:** Approved (pending final review)
**Scope:** Migrate 4 report tabs from frontend localStorage (`useData()`) to a real backend `/reports` API.

---

## Problem

`Reports.tsx` and `Analytics.tsx` are fully built UIs, but they read from `useData()`
(the legacy localStorage `DataContext`). Since orders, expenses, stock, etc. now live in
the Neon database via the API, localStorage is mostly empty — so the reports show stale
or empty data. This is a **migration**, not a new feature: the UI stays, the data source moves.

Calculations move **server-side** (Prisma `aggregate`/`groupBy`) so a report never pulls
thousands of order rows into the browser — consistent with the recent CU-hr / payload work.

## Scope — Phase 1

In scope (4 of the 8 Reports tabs):
1. **Sales** — summary + revenue trend
2. **P&L** — revenue, COGS, expenses, net profit
3. **Item-wise** — top selling items
4. **Stock** — current stock valuation

Out of scope (Phase 2, stay on `useData()` for now, page must not break):
Purchase, Expense, Staff, Waste tabs; the whole `Analytics.tsx` page.

## Architecture

New backend module `src/modules/reports/`, following the `delivery` dashboard pattern:
- `reports.controller.ts` — 4 `asyncHandler` endpoints; each runs server-side aggregation
  and returns a ready summary object (not raw rows).
- `reports.routes.ts` — `authenticate` + `authorize(['Super Admin','Admin','Manager','Accountant'])`.
- Activate the already-present commented mount in `src/routes/index.ts` (line ~156):
  `router.use('/reports', reportRoutes);`

Frontend:
- New `src/services/report.service.ts` — `getSalesReport`, `getPnlReport`, `getItemsReport`,
  `getStockReport`, each taking `{ from, to, outletId }`.
- `Reports.tsx` — the 4 in-scope tabs switch from `useData()` to the service
  (via `@tanstack/react-query`, matching other migrated pages). Charts/cards/CSV unchanged.
- Add an **outlet dropdown** (top of page) sourced from `outletService.getOutlets()`,
  alongside the existing date-range filter.

## Common request params

All endpoints: `GET /api/reports/<name>?from=YYYY-MM-DD&to=YYYY-MM-DD&outletId=<id|all>`
- `from`/`to` — inclusive date range. Invalid/missing → `ApiError.badRequest`.
- `outletId` — `all` or omitted = combined; otherwise filter to that outlet.

## Endpoint contracts

### 1. GET /api/reports/sales
```jsonc
{
  "totalSales": 145000,      // SUM(total) of COMPLETED orders in range
  "totalOrders": 87,         // COUNT of all orders in range
  "completedOrders": 72,
  "avgOrderValue": 2014,     // totalSales / completedOrders (0 if none)
  "trend": [ { "date": "06-10", "revenue": 21000 } ]  // per-day revenue, completed only
}
```

### 2. GET /api/reports/pnl
```jsonc
{
  "revenue": 145000,         // SUM(total) completed orders
  "cogs": 52000,             // sum over completed order items: recipe.qtyPerUnit * item.qty * ingredient.purchasePrice
  "expenses": 23000,         // SUM(Expense.amount) in range — see outlet limitation
  "netProfit": 70000,        // revenue - cogs - expenses
  "expenseByCategory": [ { "name": "Rent", "value": 15000 } ],
  "expensesAreRestaurantWide": true  // true when outletId != all (expenses can't be outlet-scoped — no Expense.outletId)
}
```

### 3. GET /api/reports/items
```jsonc
{
  "topItems": [ { "name": "Chicken Biryani", "qty": 42, "revenue": 25200 } ]  // completed only, sorted by revenue desc, top 20
}
```

### 4. GET /api/reports/stock  (snapshot — ignores from/to)
```jsonc
{
  "totalIngredients": 29,
  "lowStockItems": 4,        // currentStock <= lowStockLevel
  "totalValue": 89000,       // sum of currentStock * purchasePrice
  "stockByCategory": [ { "name": "Meat", "value": 45000 } ]
}
```

## Key decisions & rules

1. **COGS** comes from `FoodRecipe` and `Ingredient.purchasePrice`. `OrderItem` carries
   `menuItemId` + `variantId`, so variant-specific recipes are matched the way the frontend
   already does. An item with **no recipe contributes 0** to COGS (same as current behavior).
   A null `purchasePrice` is treated as 0.

2. **Stock report ignores `from`/`to`** — stock level is always "current"; historical
   snapshots aren't stored. Date filter applies only to sales / P&L / items.

3. **"Completed" orders** drive revenue/COGS/items (status = completed). `totalOrders`
   counts all statuses in range.

## Outlet filtering

- `outletId=all`/missing → combined (includes orders with null `outletId`).
- `outletId=<id>` → exact match on `Order.outletId` (null orders excluded).
- **Stock** filters by `Warehouse.outletId` (stock links to warehouse, not order); `all` = every warehouse.
- **LIMITATION — expenses:** `Expense` has **no `outletId` column** (verified in schema).
  So in P&L, when a specific outlet is selected, expenses cannot be scoped to it. Decision:
  expenses stay **combined (all outlets)** regardless of `outletId`, and the P&L response
  flags this so the UI can show a small note ("expenses are restaurant-wide"). Adding
  `Expense.outletId` is a separate future change, out of scope here.
- **Role scoping:** Phase 1 keeps it open — any authorized role may pass any `outletId`.
  Per-user outlet restriction is Phase 2.

## Error handling

- Invalid/missing date → `ApiError.badRequest('from and to are required (YYYY-MM-DD)')`.
- Empty result set → zeroed totals + empty arrays (UI renders empty gracefully, no crash).
- All Decimal fields → `Number()` before responding (project rule).

## Testing

Backend currently has **no test runner**. This module bootstraps one:
- Add `vitest` + `npm run test` / `test:watch` to the backend.
- Tests for the reports module: seed a small known dataset (or mock Prisma) and assert:
  sales totals, P&L math (revenue - cogs - expenses), item ranking, stock valuation,
  outlet filtering (combined vs specific), and the empty-range case.
- Target: the 4 endpoints' aggregation logic is covered.

## Out of scope (explicit)

- Purchase / Expense / Staff / Waste report tabs (Phase 2).
- The `Analytics.tsx` page (Phase 2).
- Adding `Expense.outletId` to the schema.
- Per-user/role outlet restriction.
- PDF export (CSV already exists client-side and stays).
