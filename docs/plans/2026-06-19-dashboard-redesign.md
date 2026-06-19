# Dashboard Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a single `GET /api/reports/dashboard` endpoint that aggregates today's channels, online/offline split, this-month financials + payment breakdown + growth, and a day-wise chart; then rebuild `Dashboard.tsx` to consume it (replacing 7 client-side queries) and show the new widgets per the client mockup.

**Architecture:** New pure helpers + one controller handler in the existing `reports` module (mirrors the Reports API). Frontend gets one `reportService.getDashboard()` and `Dashboard.tsx` swaps its 7 queries for one. Existing sections (Financial Overview, Payable/Receivable, Top Items/Customers) are kept; new widgets (channels, payment split, online/offline, growth, day-wise, branch name) are added.

**Tech Stack:** Express + TypeScript + Prisma (Neon Postgres) backend with vitest; React 18 + Vite + @tanstack/react-query + recharts frontend.

**Spec:** `docs/specs/2026-06-19-dashboard-redesign-design.md`

## Global Constraints

- ESM imports use the `.js` extension (e.g. `'../../config/database.js'`).
- All Prisma `Decimal` fields -> wrap in `Number(...)` before returning/using in math.
- Controllers use `asyncHandler(async (req,res) => { ... res.json(ApiResponse.success(data)) })`; errors via `throw ApiError.badRequest(msg)`.
- Reports roles: `['Super Admin', 'Admin', 'Manager', 'Accountant']`.
- `OrderType` returns the enum `@map` DISPLAY strings: `Dine In, Take Away, Delivery, Online, Self Order, Foodpanda, Walk-in`. `OrderStatus` returns display strings too (e.g. `Cancelled`, `Scheduled`).
- Online types = `Foodpanda, Online, Self Order`. Offline types = `Dine In, Take Away, Walk-in`.
- Sales basis = orders whose status is NOT cancelled/scheduled.

---

## File Structure

**Backend:**
- Modify `src/modules/reports/reports.helpers.ts` — add pure helpers: `monthBoundaries`, `dayBoundaries`, `classifyChannel`, `growthPct`, `fillChannels`, `groupPayments` + constants.
- Modify `src/modules/reports/reports.controller.ts` — add `getDashboard` handler.
- Modify `src/modules/reports/reports.routes.ts` — add `GET /dashboard`.
- Modify `src/modules/reports/__tests__/reports.helpers.test.ts` — add tests for the new helpers.

**Frontend:**
- Modify `src/services/report.service.ts` — add `DashboardReport` type + `getDashboard()`.
- Modify `src/pages/Dashboard.tsx` — consume the single endpoint; add new widgets.

---

## Task 1: Dashboard pure helpers (TDD)

Pure, DB-free functions that encode the tricky logic (time boundaries, channel classification, growth math, zero-fill). Unit-tested first.

**Files:**
- Modify: `src/modules/reports/reports.helpers.ts`
- Test: `src/modules/reports/__tests__/reports.helpers.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces:
  - `monthBoundaries(now: Date): { thisStart: Date; thisEnd: Date; lastStart: Date; lastEnd: Date }`
  - `dayBoundaries(now: Date): { gte: Date; lte: Date }`
  - `ONLINE_TYPES: string[]`, `OFFLINE_TYPES: string[]`, `CHANNEL_ORDER: string[]`
  - `classifyChannel(type: string): 'online' | 'offline'`
  - `growthPct(current: number, previous: number): number`
  - `fillChannels(rows: {type:string;sales:number;orders:number}[]): {type:string;sales:number;orders:number}[]`
  - `groupPayments(rows: {method:string|null;amount:number}[]): {method:string;amount:number}[]`

- [ ] **Step 1: Write the failing tests**

Append to `src/modules/reports/__tests__/reports.helpers.test.ts`:
```ts
import {
  monthBoundaries, dayBoundaries, classifyChannel, growthPct, fillChannels, groupPayments,
  CHANNEL_ORDER,
} from '../reports.helpers.js';

describe('monthBoundaries', () => {
  it('returns this-month and last-month UTC ranges', () => {
    const b = monthBoundaries(new Date('2026-06-19T10:00:00.000Z'));
    expect(b.thisStart.toISOString()).toBe('2026-06-01T00:00:00.000Z');
    expect(b.thisEnd.toISOString()).toBe('2026-06-30T23:59:59.999Z');
    expect(b.lastStart.toISOString()).toBe('2026-05-01T00:00:00.000Z');
    expect(b.lastEnd.toISOString()).toBe('2026-05-31T23:59:59.999Z');
  });
  it('handles January (last month = previous December)', () => {
    const b = monthBoundaries(new Date('2026-01-15T10:00:00.000Z'));
    expect(b.lastStart.toISOString()).toBe('2025-12-01T00:00:00.000Z');
    expect(b.lastEnd.toISOString()).toBe('2025-12-31T23:59:59.999Z');
  });
});

describe('dayBoundaries', () => {
  it('returns the UTC start and end of the given day', () => {
    const d = dayBoundaries(new Date('2026-06-19T14:30:00.000Z'));
    expect(d.gte.toISOString()).toBe('2026-06-19T00:00:00.000Z');
    expect(d.lte.toISOString()).toBe('2026-06-19T23:59:59.999Z');
  });
});

describe('classifyChannel', () => {
  it('classifies online types', () => {
    expect(classifyChannel('Foodpanda')).toBe('online');
    expect(classifyChannel('Online')).toBe('online');
    expect(classifyChannel('Self Order')).toBe('online');
  });
  it('classifies offline types (incl. unknown -> offline)', () => {
    expect(classifyChannel('Dine In')).toBe('offline');
    expect(classifyChannel('Take Away')).toBe('offline');
    expect(classifyChannel('Walk-in')).toBe('offline');
    expect(classifyChannel('Whatever')).toBe('offline');
  });
});

describe('growthPct', () => {
  it('computes percentage change', () => {
    expect(growthPct(120, 100)).toBe(20);
    expect(growthPct(80, 100)).toBe(-20);
  });
  it('returns 0 when previous is 0 (no divide-by-zero)', () => {
    expect(growthPct(500, 0)).toBe(0);
    expect(growthPct(0, 0)).toBe(0);
  });
});

describe('fillChannels', () => {
  it('zero-fills every channel in CHANNEL_ORDER and preserves provided values', () => {
    const out = fillChannels([{ type: 'Dine In', sales: 2867, orders: 5 }]);
    expect(out.map(c => c.type)).toEqual(CHANNEL_ORDER);
    expect(out.find(c => c.type === 'Dine In')).toEqual({ type: 'Dine In', sales: 2867, orders: 5 });
    expect(out.find(c => c.type === 'Delivery')).toEqual({ type: 'Delivery', sales: 0, orders: 0 });
  });
});

describe('groupPayments', () => {
  it('sums by method, ignores null methods, sorts desc, rounds', () => {
    const out = groupPayments([
      { method: 'Cash', amount: 100 }, { method: 'Card', amount: 50 },
      { method: 'Cash', amount: 22.4 }, { method: null, amount: 999 },
    ]);
    expect(out).toEqual([{ method: 'Cash', amount: 122 }, { method: 'Card', amount: 50 }]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd "e:/Sir Kazmi/ovenisto-flame-kissed-flavor/Ovenisto-backend" && npm run test`
Expected: FAIL — the new functions are not exported yet.

- [ ] **Step 3: Implement the helpers**

Append to `src/modules/reports/reports.helpers.ts`:
```ts
export const ONLINE_TYPES = ['Foodpanda', 'Online', 'Self Order'];
export const OFFLINE_TYPES = ['Dine In', 'Take Away', 'Walk-in'];
// Channels shown as cards (mockup order). Walk-in is counted in offline totals but has no own card.
export const CHANNEL_ORDER = ['Dine In', 'Take Away', 'Delivery', 'Foodpanda', 'Self Order', 'Online'];

/** UTC start/end of the given calendar day. */
export function dayBoundaries(now: Date): { gte: Date; lte: Date } {
  const y = now.getUTCFullYear(), m = now.getUTCMonth(), d = now.getUTCDate();
  return {
    gte: new Date(Date.UTC(y, m, d, 0, 0, 0, 0)),
    lte: new Date(Date.UTC(y, m, d, 23, 59, 59, 999)),
  };
}

/** UTC ranges for this month and last month, from `now`. */
export function monthBoundaries(now: Date): { thisStart: Date; thisEnd: Date; lastStart: Date; lastEnd: Date } {
  const y = now.getUTCFullYear(), m = now.getUTCMonth();
  const thisStart = new Date(Date.UTC(y, m, 1, 0, 0, 0, 0));
  const thisEnd = new Date(Date.UTC(y, m + 1, 0, 23, 59, 59, 999)); // day 0 of next month = last day of this
  const lastStart = new Date(Date.UTC(y, m - 1, 1, 0, 0, 0, 0));
  const lastEnd = new Date(Date.UTC(y, m, 0, 23, 59, 59, 999));
  return { thisStart, thisEnd, lastStart, lastEnd };
}

/** Online vs offline by order type. Unknown types default to offline. */
export function classifyChannel(type: string): 'online' | 'offline' {
  return ONLINE_TYPES.includes(type) ? 'online' : 'offline';
}

/** Percentage change current vs previous; 0 when previous is 0 (avoids divide-by-zero). */
export function growthPct(current: number, previous: number): number {
  if (!previous) return 0;
  return Math.round(((current - previous) / previous) * 100);
}

/** Zero-fill every channel in CHANNEL_ORDER, merging provided rows. */
export function fillChannels(
  rows: { type: string; sales: number; orders: number }[]
): { type: string; sales: number; orders: number }[] {
  const byType = new Map(rows.map((r) => [r.type, r]));
  return CHANNEL_ORDER.map((type) => byType.get(type) ?? { type, sales: 0, orders: 0 });
}

/** Sum amounts by payment method, ignoring null methods; sorted desc, rounded. */
export function groupPayments(
  rows: { method: string | null; amount: number }[]
): { method: string; amount: number }[] {
  const map = new Map<string, number>();
  for (const r of rows) {
    if (!r.method) continue;
    map.set(r.method, (map.get(r.method) ?? 0) + r.amount);
  }
  return [...map.entries()]
    .map(([method, amount]) => ({ method, amount: Math.round(amount) }))
    .sort((a, b) => b.amount - a.amount);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd "e:/Sir Kazmi/ovenisto-flame-kissed-flavor/Ovenisto-backend" && npm run test`
Expected: PASS — all previous tests plus the new ones green.

- [ ] **Step 5: Typecheck + commit**

```bash
cd "e:/Sir Kazmi/ovenisto-flame-kissed-flavor/Ovenisto-backend"
npm run typecheck   # exit 0
git add src/modules/reports/reports.helpers.ts src/modules/reports/__tests__/reports.helpers.test.ts
git commit -m "Add dashboard helpers (month/day boundaries, channel, growth) with tests"
```

---

## Task 2: getDashboard controller handler

**Files:**
- Modify: `src/modules/reports/reports.controller.ts`

**Interfaces:**
- Consumes (from Task 1): `dayBoundaries`, `monthBoundaries`, `classifyChannel`, `growthPct`, `fillChannels`, `groupPayments`.
- Produces: `export const getDashboard` (Express handler) returning the spec's dashboard JSON.

- [ ] **Step 1: Add the handler**

In `src/modules/reports/reports.controller.ts`, extend the helpers import to include the new functions:
```ts
import {
  parseDateRange, buildOrderWhere, computeCogs,
  dayBoundaries, monthBoundaries, classifyChannel, growthPct, fillChannels, groupPayments,
} from './reports.helpers.js';
```
Then append this handler at the end of the file:
```ts
const EXCLUDED_STATUSES = ['Cancelled', 'cancelled', 'Scheduled', 'scheduled', 'CANCELLED', 'SCHEDULED'];

/** GET /api/reports/dashboard?outletId=<id|all> */
export const getDashboard = asyncHandler(async (req: Request, res: Response) => {
  const outletId = req.query.outletId as string | undefined;
  const now = new Date();
  const day = dayBoundaries(now);
  const mb = monthBoundaries(now);

  const outletFilter = outletId && outletId !== 'all' ? { outletId } : {};
  const notExcluded = { status: { notIn: EXCLUDED_STATUSES as never } };

  // --- TODAY: orders by channel ---
  const todayOrders = await prisma.order.findMany({
    where: { ...outletFilter, ...notExcluded, createdAt: { gte: day.gte, lte: day.lte } },
    select: { type: true, total: true },
  });
  const channelMap = new Map<string, { type: string; sales: number; orders: number }>();
  let onlineSales = 0, onlineOrders = 0, offlineSales = 0, offlineOrders = 0;
  for (const o of todayOrders) {
    const type = String(o.type);
    const amt = Number(o.total);
    const cur = channelMap.get(type) ?? { type, sales: 0, orders: 0 };
    cur.sales += amt; cur.orders += 1;
    channelMap.set(type, cur);
    if (classifyChannel(type) === 'online') { onlineSales += amt; onlineOrders += 1; }
    else { offlineSales += amt; offlineOrders += 1; }
  }
  const channels = fillChannels([...channelMap.values()]).map((c) => ({ ...c, sales: Math.round(c.sales) }));
  const todayTotalSales = Math.round(todayOrders.reduce((s, o) => s + Number(o.total), 0));

  // --- THIS MONTH: financials, payments, online/offline totals (for growth) ---
  const monthOrders = await prisma.order.findMany({
    where: { ...outletFilter, ...notExcluded, createdAt: { gte: mb.thisStart, lte: mb.thisEnd } },
    select: { type: true, total: true, subtotal: true, discount: true, paymentMethod: true },
  });
  const grossSale = monthOrders.reduce((s, o) => s + Number(o.subtotal), 0);
  const discounts = monthOrders.reduce((s, o) => s + Number(o.discount), 0);
  const revenue = monthOrders.reduce((s, o) => s + Number(o.total), 0);
  const paymentBreakdown = groupPayments(monthOrders.map((o) => ({ method: o.paymentMethod, amount: Number(o.total) })));
  let monthOnline = 0, monthOffline = 0;
  for (const o of monthOrders) {
    if (classifyChannel(String(o.type)) === 'online') monthOnline += Number(o.total);
    else monthOffline += Number(o.total);
  }

  // --- LAST MONTH: online/offline + overall totals (for growth %) ---
  const lastOrders = await prisma.order.findMany({
    where: { ...outletFilter, ...notExcluded, createdAt: { gte: mb.lastStart, lte: mb.lastEnd } },
    select: { type: true, total: true },
  });
  let lastOnline = 0, lastOffline = 0, lastTotal = 0;
  for (const o of lastOrders) {
    const amt = Number(o.total); lastTotal += amt;
    if (classifyChannel(String(o.type)) === 'online') lastOnline += amt; else lastOffline += amt;
  }

  // --- expenses + waste this month (restaurant-wide; Expense has no outletId) ---
  const [expenseRows, wasteRows] = await Promise.all([
    prisma.expense.findMany({ where: { date: { gte: mb.thisStart, lte: mb.thisEnd } }, select: { amount: true } }),
    prisma.wasteRecord.findMany({ where: { date: { gte: mb.thisStart, lte: mb.thisEnd } }, select: { cost: true } }),
  ]);
  const expenses = expenseRows.reduce((s, e) => s + Number(e.amount), 0);
  const foodLoss = wasteRows.reduce((s, w) => s + Number(w.cost ?? 0), 0);
  const netProfit = revenue - expenses - foodLoss;

  // --- day-wise (current week Mon..Sun) ---
  const weekStart = new Date(day.gte);
  const dow = (weekStart.getUTCDay() + 6) % 7; // Mon=0
  weekStart.setUTCDate(weekStart.getUTCDate() - dow);
  const weekEnd = new Date(weekStart); weekEnd.setUTCDate(weekStart.getUTCDate() + 6); weekEnd.setUTCHours(23, 59, 59, 999);
  const weekOrders = await prisma.order.findMany({
    where: { ...outletFilter, ...notExcluded, createdAt: { gte: weekStart, lte: weekEnd } },
    select: { total: true, createdAt: true },
  });
  const labels = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const dayTotals = [0, 0, 0, 0, 0, 0, 0];
  for (const o of weekOrders) {
    const idx = (new Date(o.createdAt).getUTCDay() + 6) % 7;
    dayTotals[idx] += Number(o.total);
  }
  const daywiseSales = labels.map((label, i) => ({ label, sales: Math.round(dayTotals[i]) }));

  // --- payable / receivable / settings / top customers ---
  const [suppliers, customers, settings] = await Promise.all([
    prisma.supplier.findMany({ select: { totalDue: true } }),
    prisma.customer.findMany({ select: { name: true, totalOrders: true, totalSpent: true, outstandingDue: true } }),
    prisma.settings.findFirst({ select: { restaurantName: true } }),
  ]);
  const payable = Math.round(suppliers.reduce((s, x) => s + Number(x.totalDue), 0));
  const receivable = Math.round(customers.reduce((s, c) => s + Number(c.outstandingDue), 0));
  const topCustomers = [...customers]
    .sort((a, b) => Number(b.totalSpent) - Number(a.totalSpent))
    .slice(0, 10)
    .map((c) => ({ name: c.name, totalOrders: c.totalOrders, totalSpent: Number(c.totalSpent) }));

  // --- top items this month ---
  const monthItems = await prisma.orderItem.findMany({
    where: { order: { is: { ...outletFilter, ...notExcluded, createdAt: { gte: mb.thisStart, lte: mb.thisEnd } } } },
    select: { name: true, qty: true, price: true },
  });
  const itemMap = new Map<string, { qty: number; revenue: number }>();
  for (const it of monthItems) {
    const cur = itemMap.get(it.name) ?? { qty: 0, revenue: 0 };
    cur.qty += it.qty; cur.revenue += Number(it.price) * it.qty;
    itemMap.set(it.name, cur);
  }
  const topItems = [...itemMap.entries()]
    .map(([name, v]) => ({ name, qty: v.qty, revenue: Math.round(v.revenue) }))
    .sort((a, b) => b.revenue - a.revenue)
    .slice(0, 10);

  res.json(ApiResponse.success({
    branchName: settings?.restaurantName ?? 'Ovenisto',
    today: {
      totalSales: todayTotalSales,
      totalOrders: todayOrders.length,
      channels,
      online: { sales: Math.round(onlineSales), orders: onlineOrders },
      offline: { sales: Math.round(offlineSales), orders: offlineOrders },
    },
    month: {
      grossSale: Math.round(grossSale),
      discounts: Math.round(discounts),
      revenue: Math.round(revenue),
      expenses: Math.round(expenses),
      foodLoss: Math.round(foodLoss),
      netProfit: Math.round(netProfit),
      paymentBreakdown,
      growthOnlinePct: growthPct(monthOnline, lastOnline),
      growthOfflinePct: growthPct(monthOffline, lastOffline),
      overallGrowthPct: growthPct(revenue, lastTotal),
    },
    daywiseSales,
    payable,
    receivable,
    topItems,
    topCustomers,
  }));
});
```

- [ ] **Step 2: Typecheck**

Run: `cd "e:/Sir Kazmi/ovenisto-flame-kissed-flavor/Ovenisto-backend" && npm run typecheck`
Expected: exit 0. Verified field names (already checked against schema): Order has `type,total,subtotal,discount,paymentMethod,createdAt,outletId,status`; WasteRecord has `cost` (nullable) + `date`; Customer has `name,totalOrders,totalSpent,outstandingDue`; Supplier has `totalDue`. Prisma client accessors: `prisma.order`, `prisma.orderItem`, `prisma.expense`, `prisma.wasteRecord`, `prisma.supplier`, `prisma.customer`, `prisma.settings`. If `status: { notIn: ... as never }` errors, replace `as never` with `as any` for that filter only.

- [ ] **Step 3: Commit**

```bash
git add src/modules/reports/reports.controller.ts
git commit -m "Add getDashboard controller (channels, payments, growth, day-wise)"
```

---

## Task 3: Mount the route

**Files:**
- Modify: `src/modules/reports/reports.routes.ts`

**Interfaces:**
- Consumes: `getDashboard` from the controller.
- Produces: `GET /api/reports/dashboard` (authenticated, reports roles).

- [ ] **Step 1: Add the route**

In `src/modules/reports/reports.routes.ts`, add `getDashboard` to the controller import and add the route alongside the others:
```ts
import {
  getSalesReport, getPnlReport, getItemsReport, getStockReport, getDashboard,
} from './reports.controller.js';
// ...after the existing reportsRouter.get(...) lines:
reportsRouter.get('/dashboard', authenticate, authorize(reportRoles), getDashboard);
```

- [ ] **Step 2: Typecheck + tests**

Run: `cd "e:/Sir Kazmi/ovenisto-flame-kissed-flavor/Ovenisto-backend" && npm run typecheck && npm run test`
Expected: typecheck exit 0; all tests pass.

- [ ] **Step 3: Commit**

```bash
git add src/modules/reports/reports.routes.ts
git commit -m "Mount GET /api/reports/dashboard"
```

---

## Task 4: Verify the endpoint against the live DB

**Files:** none (manual verification).

- [ ] **Step 1: Run backend + log in**

```bash
cd "e:/Sir Kazmi/ovenisto-flame-kissed-flavor/Ovenisto-backend" && npm run dev
# in another shell:
TOKEN=$(curl -s -X POST http://localhost:3001/api/auth/login -H "Content-Type: application/json" -d '{"email":"admin@ovenisto.com","password":"password123"}' | python -c "import sys,json;print(json.load(sys.stdin)['data']['accessToken'])")
```

- [ ] **Step 2: Hit the endpoint**

```bash
curl -s "http://localhost:3001/api/reports/dashboard?outletId=all" -H "Authorization: Bearer $TOKEN" | python -m json.tool | head -70
```
Expected: `success: true` with `today.channels` (6 entries, zero-filled), `today.online`/`offline`, `month` (grossSale/revenue/netProfit/paymentBreakdown/growth*), `daywiseSales` (7 entries), `payable`, `receivable`, `topItems`, `topCustomers`, `branchName`. Sanity: `month.netProfit === revenue - expenses - foodLoss`; channel sales non-negative; growth values are integers.

- [ ] **Step 3: No commit** (verification only; fix in the relevant task if a bug appears).

---

## Task 5: Frontend dashboard service

**Files:**
- Modify: `src/services/report.service.ts`

**Interfaces:**
- Consumes: `api.get`.
- Produces: `DashboardReport` type + `reportService.getDashboard(params?: { outletId?: string }): Promise<DashboardReport>`.

- [ ] **Step 1: Add the type + method**

Add the type to `src/services/report.service.ts` (before the `reportService` object):
```ts
export interface DashboardReport {
  branchName: string;
  today: {
    totalSales: number; totalOrders: number;
    channels: { type: string; sales: number; orders: number }[];
    online: { sales: number; orders: number };
    offline: { sales: number; orders: number };
  };
  month: {
    grossSale: number; discounts: number; revenue: number; expenses: number;
    foodLoss: number; netProfit: number;
    paymentBreakdown: { method: string; amount: number }[];
    growthOnlinePct: number; growthOfflinePct: number; overallGrowthPct: number;
  };
  daywiseSales: { label: string; sales: number }[];
  payable: number; receivable: number;
  topItems: { name: string; qty: number; revenue: number }[];
  topCustomers: { name: string; totalOrders: number; totalSpent: number }[];
}
```
Add this method inside the `reportService` object:
```ts
  async getDashboard(params?: { outletId?: string }): Promise<DashboardReport> {
    const q = new URLSearchParams();
    q.set('outletId', params?.outletId && params.outletId !== 'all' ? params.outletId : 'all');
    const res = await api.get<{ success: boolean; data: DashboardReport }>(`/reports/dashboard?${q.toString()}`);
    return res.data;
  },
```

- [ ] **Step 2: Typecheck**

Run: `cd "e:/Sir Kazmi/ovenisto-flame-kissed-flavor/Ovenisto_Frontend_Software" && npx tsc --noEmit`
Expected: exit 0.

- [ ] **Step 3: Commit**

```bash
git add src/services/report.service.ts
git commit -m "Add reportService.getDashboard + DashboardReport type"
```

---

## Task 6: Rebuild Dashboard.tsx on the single endpoint + new widgets

Replace the 7 client-side queries with one `getDashboard` query, and add the new widgets (channels, online/offline, payment split, growth, day-wise, branch name) while keeping the existing Financial Overview, Payable/Receivable, and Top Items/Customers sections.

**Files:**
- Modify: `src/pages/Dashboard.tsx`

**Interfaces:**
- Consumes: `reportService.getDashboard`, `DashboardReport`.
- Produces: the rebuilt Dashboard page (no new exports).

- [ ] **Step 1: Swap data source**

In `src/pages/Dashboard.tsx`, remove the 7 `useQuery` hooks and the derived arrays (the `dashboard-orders`/`-ingredients`/`-customers`/`-suppliers`/`-expenses`/`-waste`/`settings` block, currently lines ~24-38) and the now-unused service imports (`orderService`, `inventoryService`, `customerService`, `supplierService`, `expenseService`, `stockService`, `settingsService`). Add:
```ts
import { reportService, type DashboardReport } from "@/services/report.service";
// inside the component:
const { data: d, isLoading: loading } = useQuery({
  queryKey: ["dashboard"],
  queryFn: () => reportService.getDashboard(),
});
const currency = "Rs.";
```
Delete ALL the old client-side aggregation (the `todayOrders`/`todaySales`/`grossSale`/`netProfit`/`topTenItems`/hourly/daily/weekly/monthly/yearly map code) — those values now come from `d.today`, `d.month`, `d.daywiseSales`, `d.topItems`, `d.topCustomers`. Keep the `if (loading) return <Skeleton .../>` early return.

- [ ] **Step 2: Build the widgets**

Rewrite the `return (...)` so it renders, in order, guarding every read with `d?.` and `?? 0` / `?? []`:
1. `<PageHeader title="Dashboard" subtitle={d?.branchName ?? ""} />` plus a compact `BarChart` of `d?.daywiseSales ?? []` (existing recharts imports) in the header area.
2. **Today channels** card grid: a "Total Offline Sale" card (`d?.today.offline.sales` / `.orders`), one card each for the channels in `d?.today.channels` (label by `c.type`, value `c.sales`, sub `c.orders + " orders"`), and a "Total Online Sale" card (`d?.today.online`). Render 0 values too.
3. **Payment methods** panel: `const pays = d?.month.paymentBreakdown ?? []; const maxPay = Math.max(1, ...pays.map(p=>p.amount));` then map each to a row with label, a bar `style={{ width: (p.amount/maxPay*100) + "%" }}`, and `currency + " " + p.amount.toLocaleString()`.
4. **Growth** three cards from `d?.month.growthOnlinePct/growthOfflinePct/overallGrowthPct`; show `(v>=0?"+":"") + v + "%"`, `text-success` when `v>=0` else `text-destructive`, with an up/down arrow icon already imported (`ArrowUpCircle`/`ArrowDownCircle` or `TrendingUp`/`TrendingDown`).
5. **Financial Overview**: existing card markup reading `d?.month.grossSale`, `revenue`, `foodLoss`, `netProfit`, `discounts`.
6. **Payable & Receivable**: existing markup reading `d?.payable`, `d?.receivable`.
7. **Top 10 Items** (`d?.topItems ?? []`: `name`, `qty`, `revenue`) and **Top 10 Customers** (`d?.topCustomers ?? []`: `name`, `totalOrders`, `totalSpent`) — existing table markup with the new field names.

- [ ] **Step 3: Typecheck**

Run: `cd "e:/Sir Kazmi/ovenisto-flame-kissed-flavor/Ovenisto_Frontend_Software" && npx tsc --noEmit`
Expected: exit 0. Remove any now-unused imports it flags.

- [ ] **Step 4: Build**

Run: `npm run build`
Expected: exit 0.

- [ ] **Step 5: Commit**

```bash
git add src/pages/Dashboard.tsx
git commit -m "Rebuild Dashboard on /api/reports/dashboard with channel/payment/growth widgets"
```

---

## Task 7: Manual UI verification

**Files:** none.

- [ ] **Step 1:** Run both servers (`npm run dev` in backend and frontend).
- [ ] **Step 2:** Open the Dashboard, log in as Super Admin.
- [ ] **Step 3:** Verify the new widgets render with real data: today's channel cards (0-filled where no orders), online/offline totals, payment-method bars, three growth cards (color by sign), day-wise bar chart, branch name in the header, and the kept Financial/Payable/Top sections. No console crash; revisiting the page should paint from cache.

---

## Task 8: Final review + push (with user consent)

- [ ] **Step 1:** `cd Ovenisto-backend && npm run test && npm run typecheck` -> tests pass, exit 0.
- [ ] **Step 2:** `cd Ovenisto_Frontend_Software && npx tsc --noEmit && npm run build` -> both exit 0.
- [ ] **Step 3:** Push both repos (ONLY after the user confirms): `git push origin main` in each. Railway redeploys backend; Vercel redeploys frontend.

---

## Notes for the implementer

- **Dough lifecycle / expiry widget is NOT in this plan** — it is Spec 2.
- Keep all Decimal reads wrapped in `Number()`.
- The dashboard is a single react-query key `["dashboard"]`; it benefits from the existing 60s staleTime + localStorage persist already configured in App.tsx.
- If the frontend `currency` must reflect the real settings currency, fetch it with a small separate `settingsService.getSettings()` query (kept out of the main dashboard endpoint to keep it focused); default `"Rs."` is acceptable for v1.
