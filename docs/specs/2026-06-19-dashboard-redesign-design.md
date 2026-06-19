# Dashboard Redesign — Design Spec (Spec 1 of 2)

**Date:** 2026-06-19
**Status:** Approved (pending final review)
**Scope:** Rebuild the Dashboard to match the client mockup — add order-channel breakdown, payment-method split, online/offline sales, growth metrics, and a day-wise sales chart, served by a single new backend dashboard endpoint.

> **Companion spec (separate, later):** "Dough lifecycle" (short shelf-life ingredient produced in Production, 8-hour countdown, recipe deduction, dashboard expiry widget) is **Spec 2** — NOT in this spec. The mockup's "dough batch" / expiry corner widget is deferred to Spec 2.

---

## Problem / goal

The current Dashboard works (already on the API via react-query) but shows a generic layout. The client wants a richer operational dashboard (see mockup): today's sales split by order channel, an online-vs-offline summary, a payment-method breakdown, month growth metrics, a day-wise sales chart, and the branch name — while keeping the existing good sections (financial overview, payable/receivable, top items).

Today the Dashboard fires 7 separate react-query calls. We replace those with ONE backend dashboard endpoint that aggregates server-side (faster, consistent with the Reports API).

## Architecture

New backend endpoint **`GET /api/reports/dashboard`** in the existing `reports` module (mirrors the Reports API pattern: `asyncHandler`, `ApiResponse.success`, Decimal→Number, `authorize` for dashboard-viewing roles).

- No required date params. The endpoint derives three time windows itself from the server clock (`new Date()`): **today**, **this month**, and **last month** (last month is needed for growth %). Boundary helpers live in `reports.helpers.ts` alongside the existing date helpers.
- Optional `outletId` query param (default = all outlets) to scope everything, consistent with the Reports API.

Frontend: add `reportService.getDashboard({ outletId? })` to `report.service.ts`. `Dashboard.tsx` replaces its 7 queries with ONE `useQuery(["dashboard", outletId], ...)`. Existing sections (Financial Overview, Payable/Receivable, Top Items, Top Customers) keep their JSX but read from this one response; new widgets are added per the layout below.

## Definitions (agreed)

- **Order channels** = `Order.type`: Dine In, Take Away (shown as "PickUp"), Delivery, Online, Self Order, Foodpanda, Walk-in. (Uber is NOT in the system yet — deferred.)
- **Online sales** = orders where `type` in { Foodpanda, Online, Self Order } (3rd-party / web). (Uber would join here later.)
- **Offline sales** = orders where `type` in { Dine In, Take Away, Walk-in } (counter / POS).
- **Growth %** = (thisMonth - lastMonth) / lastMonth * 100, computed for online sales, offline sales, and overall. Returns 0 when lastMonth is 0 (avoid divide-by-zero).
- **Period mix:** top channel + online/offline cards = **TODAY**; financial + payment-breakdown + growth = **THIS MONTH**; day-wise chart = current week (Mon-Sun).
- **Payment methods:** whatever `Order.paymentMethod` actually contains (real POS values: Cash, Card, JazzCash, EasyPaisa, Online, ...). The mockup's GooglePay/Paytm were Indian examples — we render the real methods present in data, not a hardcoded list.
- **Revenue/sales basis:** non-cancelled, non-scheduled orders (match the current Dashboard's `activeOrders2` rule).

## Endpoint contract

`GET /api/reports/dashboard?outletId=<id|all>`
```jsonc
{
  "branchName": "Ovenisto Main Branch",        // Settings.restaurantName (or outlet name if outletId given)
  "today": {
    "totalSales": 4307,
    "totalOrders": 7,
    "channels": [                               // every channel, 0-filled if no orders today
      { "type": "Dine In",   "sales": 2867, "orders": 5 },
      { "type": "Take Away", "sales": 1440, "orders": 2 },
      { "type": "Delivery",  "sales": 0,    "orders": 0 },
      { "type": "Foodpanda", "sales": 0,    "orders": 0 },
      { "type": "Self Order","sales": 0,    "orders": 0 },
      { "type": "Online",    "sales": 0,    "orders": 0 }
    ],
    "online":  { "sales": 0,    "orders": 0 },  // Foodpanda+Online+Self Order
    "offline": { "sales": 4307, "orders": 7 }   // Dine In+Take Away+Walk-in
  },
  "month": {
    "grossSale": 21490,
    "discounts": 350,
    "revenue": 24523,
    "expenses": 23000,
    "foodLoss": 1440,                           // sum of WasteRecord.cost this month
    "netProfit": -493917,                       // revenue - expenses - foodLoss
    "paymentBreakdown": [                        // real methods present, sorted desc
      { "method": "Cash", "amount": 7622 },
      { "method": "Card", "amount": 1760 },
      { "method": "JazzCash", "amount": 620 },
      { "method": "EasyPaisa", "amount": 181 }
    ],
    "growthOnlinePct": 0,
    "growthOfflinePct": -8,
    "overallGrowthPct": -12
  },
  "daywiseSales": [                              // current week Mon..Sun
    { "label": "Mon", "sales": 12000 }, { "label": "Tue", "sales": 8400 }
  ],
  "payable": 26700,                             // sum supplier.totalDue
  "receivable": 4188,                           // sum customer.outstandingDue
  "topItems": [ { "name": "Cheese Pizza", "qty": 42, "revenue": 25200 } ],   // top 10, this month
  "topCustomers": [ { "name": "Ali", "totalOrders": 9, "totalSpent": 18000 } ] // top 10
}
```

## Frontend layout (top -> bottom, matches mockup)

1. **Header:** PageHeader "Dashboard" + branch name; a compact day-wise sales bar-chart (Mon-Sun) top-right.
2. **Today — Channels:** card grid -> Total Offline Sale, Dine In, PickUp (Take Away); Total Online Sale, Foodpanda, Delivery, Self Order/Online. Each card: amount + order count. 0-value channels still render.
3. **Payment Methods (this month):** a panel with one row per real method -> label + progress bar (relative to the largest) + amount.
4. **Growth (vs last month):** three cards -> Growth Online, Growth Offline, Overall Growth — % with up/down arrow, green/red.
5. **Financial Overview (this month):** existing cards -> Gross Sale, Revenue, Food Loss, Net Profit. (Kept.)
6. **Payable & Receivable:** existing, as-is.
7. **Top 10 Best-Selling Items + Top 10 Customers:** existing, as-is.

Charts use the existing `recharts` dependency. All money via the settings currency (`settings.currency`, default "Rs.").

## Performance

Replacing 7 queries with 1 reduces dashboard round-trips and pairs with the existing react-query cache + persist. The endpoint runs a handful of grouped Prisma queries (orders today, orders this month, orders last month for growth, expenses/waste this month, suppliers, customers, settings) — all bounded aggregations, not row dumps.

## Error handling

- Empty data -> zeroed totals + empty arrays + 0% growth (page renders, no crash).
- All Decimal -> `Number()`.
- `outletId` filtering: orders/payments/channels filter by `Order.outletId`; expenses are restaurant-wide (Expense has no outletId — same limitation noted in the Reports spec), so the financial "expenses" line stays restaurant-wide when a specific outlet is selected.

## Testing

Add vitest unit tests (backend test runner already exists) for the pure helpers: online/offline classification of an order type, growth-% calc (incl. divide-by-zero -> 0), channel 0-fill, and payment-breakdown grouping. The endpoint's wiring is verified manually against the live DB (like the Reports endpoints).

## Out of scope (explicit)

- **Dough lifecycle / expiry / "dough batch" widget** -> Spec 2.
- **Uber Eats** channel (not in the system).
- Date-range picker on the dashboard (fixed today / this-month windows for now).
- Per-user/role outlet restriction (any authorized role may pass any outletId).
