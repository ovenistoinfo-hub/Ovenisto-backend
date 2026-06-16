# Reports API (Phase 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the localStorage data source of 4 Reports tabs (Sales, P&L, Item-wise, Stock) with a real backend `/api/reports` API that aggregates server-side.

**Architecture:** New backend module `src/modules/reports/` (controller + routes) following the existing `delivery` dashboard pattern. Each endpoint runs Prisma aggregation and returns a ready summary object. A new frontend `report.service.ts` feeds the existing Reports UI via `@tanstack/react-query`. Backend gets a vitest test runner (first in the repo).

**Tech Stack:** Express + TypeScript + Prisma (PostgreSQL/Neon) backend; React + Vite + react-query frontend; vitest for tests.

**Spec:** `docs/specs/2026-06-16-reports-api-design.md`

**Conventions confirmed from codebase:**
- Controllers use `asyncHandler(async (req, res) => { ... res.json(ApiResponse.success(data)) })`.
- Errors: `throw ApiError.badRequest('msg')`.
- Routes: `router.get('/x', authenticate, authorize([...roles]), handler)`.
- Decimal fields -> `Number(field)` before responding.
- ESM imports use `.js` extension (e.g. `'../../config/database.js'`).
- Frontend services wrap `api` from `./api` and return `res.data`.

**Roles for reports:** `['Super Admin', 'Admin', 'Manager', 'Accountant']`

---

## File Structure

**Backend (create):**
- `src/modules/reports/reports.helpers.ts` — pure date/outlet parsing + COGS helpers (unit-testable, no DB).
- `src/modules/reports/reports.controller.ts` — 4 endpoint handlers.
- `src/modules/reports/reports.routes.ts` — router with auth/authorize.
- `src/modules/reports/__tests__/reports.helpers.test.ts` — unit tests for pure helpers.
- `vitest.config.ts` — test config.

**Backend (modify):**
- `src/routes/index.ts` — import + mount `/reports` (line ~28 import area, line ~156 mount).
- `package.json` — add vitest devDeps + `test`/`test:watch` scripts.

**Frontend (create):**
- `src/services/report.service.ts` — 4 typed fetch functions.

**Frontend (modify):**
- `src/pages/Reports.tsx` — 4 in-scope tabs read from service; add outlet dropdown.

---

## Task 1: Add vitest test runner to backend

**Files:**
- Modify: `Ovenisto-backend/package.json`
- Create: `Ovenisto-backend/vitest.config.ts`

- [ ] **Step 1: Install vitest**

Run (in `Ovenisto-backend/`):
```bash
npm install -D vitest@^2.1.0
```
Expected: adds `vitest` to devDependencies, no errors.

- [ ] **Step 2: Add test scripts to package.json**

In `package.json`, modify the `"scripts"` block — add two lines after `"typecheck"`:
```jsonc
"typecheck": "tsc --noEmit",
"test": "vitest run",
"test:watch": "vitest"
```
(Add a comma after the existing `"typecheck"` line.)

- [ ] **Step 3: Create vitest.config.ts**

Create `Ovenisto-backend/vitest.config.ts`:
```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
```

- [ ] **Step 4: Verify the runner works (no tests yet = passes with "no tests")**

Run: `npm run test`
Expected: vitest runs, reports "No test files found" OR exits 0. Either is fine — runner is wired.

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json vitest.config.ts
git commit -m "Add vitest test runner to backend"
```

---

## Task 2: Pure helpers (date range + outlet filter + COGS) — TDD

These are pure functions with no DB access, so they're fast to unit-test and lock down the tricky logic (date validation, COGS math).

**Files:**
- Create: `Ovenisto-backend/src/modules/reports/reports.helpers.ts`
- Test: `Ovenisto-backend/src/modules/reports/__tests__/reports.helpers.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/modules/reports/__tests__/reports.helpers.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { parseDateRange, buildOrderWhere, computeCogs } from '../reports.helpers.js';

describe('parseDateRange', () => {
  it('parses valid from/to into inclusive day boundaries', () => {
    const { gte, lte } = parseDateRange('2026-06-01', '2026-06-07');
    expect(gte.toISOString()).toBe('2026-06-01T00:00:00.000Z');
    expect(lte.toISOString()).toBe('2026-06-07T23:59:59.999Z');
  });

  it('throws on missing from', () => {
    expect(() => parseDateRange(undefined, '2026-06-07')).toThrow();
  });

  it('throws on invalid date', () => {
    expect(() => parseDateRange('not-a-date', '2026-06-07')).toThrow();
  });
});

describe('buildOrderWhere', () => {
  const gte = new Date('2026-06-01T00:00:00.000Z');
  const lte = new Date('2026-06-07T23:59:59.999Z');

  it('omits outletId when outlet is "all"', () => {
    const where = buildOrderWhere(gte, lte, 'all');
    expect(where).toEqual({ createdAt: { gte, lte } });
  });

  it('adds outletId when a specific outlet is given', () => {
    const where = buildOrderWhere(gte, lte, 'outlet-123');
    expect(where).toEqual({ createdAt: { gte, lte }, outletId: 'outlet-123' });
  });

  it('treats undefined outlet as all', () => {
    const where = buildOrderWhere(gte, lte, undefined);
    expect(where).toEqual({ createdAt: { gte, lte } });
  });
});

describe('computeCogs', () => {
  it('sums recipe qty * item qty * purchasePrice for matching recipes', () => {
    const items = [
      { menuItemId: 'm1', variantId: null, qty: 2 },
      { menuItemId: 'm2', variantId: 'v1', qty: 1 },
    ];
    const recipes = [
      { menuItemId: 'm1', variantId: null, ingredientId: 'i1', qtyPerUnit: 3 },
      { menuItemId: 'm2', variantId: 'v1', ingredientId: 'i1', qtyPerUnit: 5 },
      { menuItemId: 'm2', variantId: 'v2', ingredientId: 'i1', qtyPerUnit: 99 }, // wrong variant, ignored
    ];
    const priceById = new Map([['i1', 10]]);
    // m1: 3 * 2 * 10 = 60 ; m2/v1: 5 * 1 * 10 = 50 ; total = 110
    expect(computeCogs(items, recipes, priceById)).toBe(110);
  });

  it('contributes 0 for items with no matching recipe', () => {
    const items = [{ menuItemId: 'mX', variantId: null, qty: 5 }];
    expect(computeCogs(items, [], new Map())).toBe(0);
  });

  it('treats missing purchasePrice as 0', () => {
    const items = [{ menuItemId: 'm1', variantId: null, qty: 2 }];
    const recipes = [{ menuItemId: 'm1', variantId: null, ingredientId: 'i1', qtyPerUnit: 3 }];
    expect(computeCogs(items, recipes, new Map())).toBe(0);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run test`
Expected: FAIL — cannot find module `../reports.helpers.js` / functions undefined.

- [ ] **Step 3: Write the implementation**

Create `src/modules/reports/reports.helpers.ts`:
```ts
import { ApiError } from '../../utils/ApiError.js';

export interface DateRange {
  gte: Date;
  lte: Date;
}

/** Parse inclusive from/to (YYYY-MM-DD) into UTC day boundaries. Throws ApiError on invalid input. */
export function parseDateRange(from: string | undefined, to: string | undefined): DateRange {
  if (!from || !to) {
    throw ApiError.badRequest('from and to are required (YYYY-MM-DD)');
  }
  const gte = new Date(`${from}T00:00:00.000Z`);
  const lte = new Date(`${to}T23:59:59.999Z`);
  if (isNaN(gte.getTime()) || isNaN(lte.getTime())) {
    throw ApiError.badRequest('from and to must be valid dates (YYYY-MM-DD)');
  }
  return { gte, lte };
}

/** Build a Prisma `where` for orders: date range, plus outletId only when a specific outlet is chosen. */
export function buildOrderWhere(gte: Date, lte: Date, outletId: string | undefined) {
  const where: { createdAt: { gte: Date; lte: Date }; outletId?: string } = {
    createdAt: { gte, lte },
  };
  if (outletId && outletId !== 'all') {
    where.outletId = outletId;
  }
  return where;
}

export interface CogsItem {
  menuItemId: string | null;
  variantId: string | null;
  qty: number;
}
export interface CogsRecipe {
  menuItemId: string;
  variantId: string | null;
  ingredientId: string;
  qtyPerUnit: number;
}

/**
 * COGS = sum over order items of (matching recipe qtyPerUnit * item.qty * ingredient.purchasePrice).
 * A recipe matches when menuItemId equals; if the item has a variantId, the recipe's variantId must
 * equal it, otherwise the recipe must be variant-less (item-level). Missing price -> 0. No recipe -> 0.
 */
export function computeCogs(
  items: CogsItem[],
  recipes: CogsRecipe[],
  purchasePriceByIngredient: Map<string, number>
): number {
  let total = 0;
  for (const item of items) {
    if (!item.menuItemId) continue;
    const matching = recipes.filter((r) => {
      if (r.menuItemId !== item.menuItemId) return false;
      return item.variantId ? r.variantId === item.variantId : !r.variantId;
    });
    for (const r of matching) {
      const price = purchasePriceByIngredient.get(r.ingredientId) ?? 0;
      total += r.qtyPerUnit * item.qty * price;
    }
  }
  return Math.round(total);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm run test`
Expected: PASS — all 9 assertions green.

- [ ] **Step 5: Commit**

```bash
git add src/modules/reports/reports.helpers.ts src/modules/reports/__tests__/reports.helpers.test.ts
git commit -m "Add reports helpers (date range, outlet where, COGS) with tests"
```

---

## Task 3: Reports controller — 4 endpoints

No DB unit tests here (repo has no Prisma mock harness yet); the pure logic is already covered in Task 2, and the live endpoints are verified manually in Task 6. Keep each handler small.

**Files:**
- Create: `Ovenisto-backend/src/modules/reports/reports.controller.ts`

- [ ] **Step 1: Create the controller**

Create `src/modules/reports/reports.controller.ts`:
```ts
/**
 * Reports Controller (Phase 1)
 * Server-side aggregation for Sales, P&L, Item-wise, and Stock reports.
 */
import type { Request, Response } from 'express';
import { prisma } from '../../config/database.js';
import { ApiResponse } from '../../utils/ApiResponse.js';
import { asyncHandler } from '../../utils/asyncHandler.js';
import { parseDateRange, buildOrderWhere, computeCogs } from './reports.helpers.js';

const COMPLETED = 'COMPLETED'; // Prisma OrderStatus enum value for completed orders

function getParams(req: Request) {
  const from = req.query.from as string | undefined;
  const to = req.query.to as string | undefined;
  const outletId = req.query.outletId as string | undefined;
  const { gte, lte } = parseDateRange(from, to);
  return { gte, lte, outletId };
}

/** GET /api/reports/sales */
export const getSalesReport = asyncHandler(async (req: Request, res: Response) => {
  const { gte, lte, outletId } = getParams(req);
  const baseWhere = buildOrderWhere(gte, lte, outletId);
  const completedWhere = { ...baseWhere, status: COMPLETED as never };

  const [totalOrders, completed] = await Promise.all([
    prisma.order.count({ where: baseWhere }),
    prisma.order.findMany({
      where: completedWhere,
      select: { total: true, createdAt: true },
    }),
  ]);

  const totalSales = completed.reduce((s, o) => s + Number(o.total), 0);
  const completedOrders = completed.length;
  const avgOrderValue = completedOrders > 0 ? Math.round(totalSales / completedOrders) : 0;

  const byDay = new Map<string, number>();
  for (const o of completed) {
    const key = o.createdAt.toISOString().slice(5, 10); // MM-DD
    byDay.set(key, (byDay.get(key) ?? 0) + Number(o.total));
  }
  const trend = [...byDay.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, revenue]) => ({ date, revenue: Math.round(revenue) }));

  res.json(
    ApiResponse.success({
      totalSales: Math.round(totalSales),
      totalOrders,
      completedOrders,
      avgOrderValue,
      trend,
    })
  );
});

/** GET /api/reports/pnl */
export const getPnlReport = asyncHandler(async (req: Request, res: Response) => {
  const { gte, lte, outletId } = getParams(req);
  const completedWhere = { ...buildOrderWhere(gte, lte, outletId), status: COMPLETED as never };

  const completed = await prisma.order.findMany({
    where: completedWhere,
    select: {
      total: true,
      items: { select: { menuItemId: true, variantId: true, qty: true } },
    },
  });

  const revenue = completed.reduce((s, o) => s + Number(o.total), 0);

  // COGS: gather all menuItemIds across the completed items, load their recipes + ingredient prices.
  const menuItemIds = [
    ...new Set(
      completed.flatMap((o) => o.items.map((i) => i.menuItemId).filter((x): x is string => !!x))
    ),
  ];
  let cogs = 0;
  if (menuItemIds.length > 0) {
    const recipes = await prisma.foodRecipe.findMany({
      where: { menuItemId: { in: menuItemIds } },
      select: { menuItemId: true, variantId: true, ingredientId: true, qtyPerUnit: true },
    });
    const ingredientIds = [...new Set(recipes.map((r) => r.ingredientId))];
    const ingredients = await prisma.ingredient.findMany({
      where: { id: { in: ingredientIds } },
      select: { id: true, purchasePrice: true },
    });
    const priceById = new Map(ingredients.map((i) => [i.id, Number(i.purchasePrice ?? 0)]));
    const allItems = completed.flatMap((o) => o.items);
    const recipesForCogs = recipes.map((r) => ({
      menuItemId: r.menuItemId,
      variantId: r.variantId,
      ingredientId: r.ingredientId,
      qtyPerUnit: Number(r.qtyPerUnit),
    }));
    cogs = computeCogs(allItems, recipesForCogs, priceById);
  }

  // Expenses: Expense has NO outletId column, so it is always restaurant-wide.
  const expenseRows = await prisma.expense.findMany({
    where: { date: { gte, lte } },
    select: { amount: true, category: true },
  });
  const expenses = expenseRows.reduce((s, e) => s + Number(e.amount), 0);
  const catMap = new Map<string, number>();
  for (const e of expenseRows) {
    const name = e.category ?? 'Uncategorized';
    catMap.set(name, (catMap.get(name) ?? 0) + Number(e.amount));
  }
  const expenseByCategory = [...catMap.entries()].map(([name, value]) => ({
    name,
    value: Math.round(value),
  }));

  const expensesAreRestaurantWide = !!outletId && outletId !== 'all';

  res.json(
    ApiResponse.success({
      revenue: Math.round(revenue),
      cogs,
      expenses: Math.round(expenses),
      netProfit: Math.round(revenue - cogs - expenses),
      expenseByCategory,
      expensesAreRestaurantWide,
    })
  );
});

/** GET /api/reports/items */
export const getItemsReport = asyncHandler(async (req: Request, res: Response) => {
  const { gte, lte, outletId } = getParams(req);
  const completedWhere = { ...buildOrderWhere(gte, lte, outletId), status: COMPLETED as never };

  const items = await prisma.orderItem.findMany({
    where: { order: { is: completedWhere } },
    select: { name: true, qty: true, price: true },
  });

  const map = new Map<string, { qty: number; revenue: number }>();
  for (const it of items) {
    const cur = map.get(it.name) ?? { qty: 0, revenue: 0 };
    cur.qty += it.qty;
    cur.revenue += Number(it.price) * it.qty;
    map.set(it.name, cur);
  }
  const topItems = [...map.entries()]
    .map(([name, v]) => ({ name, qty: v.qty, revenue: Math.round(v.revenue) }))
    .sort((a, b) => b.revenue - a.revenue)
    .slice(0, 20);

  res.json(ApiResponse.success({ topItems }));
});

/** GET /api/reports/stock — current snapshot, ignores from/to */
export const getStockReport = asyncHandler(async (req: Request, res: Response) => {
  const outletId = req.query.outletId as string | undefined;

  // Stock links to warehouses; filter ingredients' warehouse stock by outlet when specified.
  // Phase 1 uses the global Ingredient table (currentStock/lowStockLevel/purchasePrice) for valuation,
  // matching the current frontend behavior. Outlet-specific stock is a Phase 2 refinement.
  const ingredients = await prisma.ingredient.findMany({
    select: {
      currentStock: true,
      lowStockLevel: true,
      purchasePrice: true,
      category: { select: { name: true } },
    },
  });

  const totalIngredients = ingredients.length;
  let lowStockItems = 0;
  let totalValue = 0;
  const catMap = new Map<string, number>();
  for (const i of ingredients) {
    const stock = Number(i.currentStock);
    const low = Number(i.lowStockLevel);
    const price = Number(i.purchasePrice ?? 0);
    if (stock <= low) lowStockItems += 1;
    const value = stock * price;
    totalValue += value;
    const name = i.category?.name ?? 'Uncategorized';
    catMap.set(name, (catMap.get(name) ?? 0) + value);
  }
  const stockByCategory = [...catMap.entries()].map(([name, value]) => ({
    name,
    value: Math.round(value),
  }));

  // outletId accepted for API symmetry; Phase 1 valuation is global. Reference it to avoid unused-var lint.
  void outletId;

  res.json(
    ApiResponse.success({
      totalIngredients,
      lowStockItems,
      totalValue: Math.round(totalValue),
      stockByCategory,
    })
  );
});
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: exit 0, no errors. (If `status: COMPLETED as never` complains, confirm the Prisma `OrderStatus` enum value is `COMPLETED` via `grep -n "COMPLETED" prisma/schema.prisma` and adjust the literal.)

- [ ] **Step 3: Commit**

```bash
git add src/modules/reports/reports.controller.ts
git commit -m "Add reports controller: sales, pnl, items, stock endpoints"
```

---

## Task 4: Reports routes + mount

**Files:**
- Create: `Ovenisto-backend/src/modules/reports/reports.routes.ts`
- Modify: `Ovenisto-backend/src/routes/index.ts`

- [ ] **Step 1: Create the router**

Create `src/modules/reports/reports.routes.ts`:
```ts
import { Router } from 'express';
import { authenticate } from '../../middleware/authenticate.js';
import { authorize } from '../../middleware/authorize.js';
import {
  getSalesReport,
  getPnlReport,
  getItemsReport,
  getStockReport,
} from './reports.controller.js';

const reportRoles = ['Super Admin', 'Admin', 'Manager', 'Accountant'];

export const reportsRouter = Router();

reportsRouter.get('/sales', authenticate, authorize(reportRoles), getSalesReport);
reportsRouter.get('/pnl',   authenticate, authorize(reportRoles), getPnlReport);
reportsRouter.get('/items', authenticate, authorize(reportRoles), getItemsReport);
reportsRouter.get('/stock', authenticate, authorize(reportRoles), getStockReport);
```

- [ ] **Step 2: Add the import in routes/index.ts**

In `src/routes/index.ts`, after line 28 (`import { purchaseRequestsRouter } ...`), add:
```ts
import { reportsRouter } from '../modules/reports/reports.routes.js';
```

- [ ] **Step 3: Replace the commented mount**

In `src/routes/index.ts`, change line ~156 from:
```ts
// router.use('/reports', reportRoutes);
```
to:
```ts
router.use('/reports', reportsRouter);
```

- [ ] **Step 4: Typecheck + build**

Run: `npm run typecheck`
Expected: exit 0.

- [ ] **Step 5: Commit**

```bash
git add src/modules/reports/reports.routes.ts src/routes/index.ts
git commit -m "Mount /api/reports routes"
```

---

## Task 5: Frontend report service

**Files:**
- Create: `Ovenisto_Frontend_Software/src/services/report.service.ts`

- [ ] **Step 1: Create the service**

Create `src/services/report.service.ts`:
```ts
import { api } from './api';

export interface SalesReport {
  totalSales: number;
  totalOrders: number;
  completedOrders: number;
  avgOrderValue: number;
  trend: { date: string; revenue: number }[];
}

export interface PnlReport {
  revenue: number;
  cogs: number;
  expenses: number;
  netProfit: number;
  expenseByCategory: { name: string; value: number }[];
  expensesAreRestaurantWide: boolean;
}

export interface ItemsReport {
  topItems: { name: string; qty: number; revenue: number }[];
}

export interface StockReport {
  totalIngredients: number;
  lowStockItems: number;
  totalValue: number;
  stockByCategory: { name: string; value: number }[];
}

export interface ReportParams {
  from: string; // YYYY-MM-DD
  to: string;   // YYYY-MM-DD
  outletId?: string; // omit or 'all' for combined
}

function qs(params: ReportParams): string {
  const q = new URLSearchParams({ from: params.from, to: params.to });
  if (params.outletId && params.outletId !== 'all') q.set('outletId', params.outletId);
  else q.set('outletId', 'all');
  return q.toString();
}

export const reportService = {
  async getSales(params: ReportParams): Promise<SalesReport> {
    const res = await api.get<{ success: boolean; data: SalesReport }>(`/reports/sales?${qs(params)}`);
    return res.data;
  },
  async getPnl(params: ReportParams): Promise<PnlReport> {
    const res = await api.get<{ success: boolean; data: PnlReport }>(`/reports/pnl?${qs(params)}`);
    return res.data;
  },
  async getItems(params: ReportParams): Promise<ItemsReport> {
    const res = await api.get<{ success: boolean; data: ItemsReport }>(`/reports/items?${qs(params)}`);
    return res.data;
  },
  async getStock(params: ReportParams): Promise<StockReport> {
    const res = await api.get<{ success: boolean; data: StockReport }>(`/reports/stock?${qs(params)}`);
    return res.data;
  },
};
```

- [ ] **Step 2: Typecheck**

Run (in `Ovenisto_Frontend_Software/`): `npx tsc --noEmit`
Expected: exit 0.

- [ ] **Step 3: Commit**

```bash
git add src/services/report.service.ts
git commit -m "Add frontend report.service.ts"
```

---

## Task 6: Verify backend endpoints against live DB

Before wiring the UI, confirm the API returns sane numbers. The backend is deployed (Railway) and the DB has data.

**Files:** none (manual verification)

- [ ] **Step 1: Start the backend locally**

Run (in `Ovenisto-backend/`): `npm run dev`
Expected: server boots on port 3001, "Database connected successfully".

- [ ] **Step 2: Get a token**

Log in via the existing auth endpoint (use a known Super Admin account):
```bash
curl -s -X POST http://localhost:3001/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"admin@ovenisto.com","password":"<password>"}'
```
Copy the `accessToken` from the response.

- [ ] **Step 3: Hit each endpoint**

```bash
TOKEN="<accessToken>"
for ep in "sales" "pnl" "items" "stock"; do
  echo "--- $ep ---"
  curl -s "http://localhost:3001/api/reports/$ep?from=2026-01-01&to=2026-12-31&outletId=all" \
    -H "Authorization: Bearer $TOKEN" | head -c 600; echo
done
```
Expected: each returns `{"success":true,"data":{...}}` with plausible numbers (sales totals match known orders, P&L netProfit = revenue - cogs - expenses, stock totals non-negative).

- [ ] **Step 4: Verify the bad-date guard**

```bash
curl -s "http://localhost:3001/api/reports/sales?outletId=all" -H "Authorization: Bearer $TOKEN"
```
Expected: `{"success":false,"error":"from and to are required (YYYY-MM-DD)"}` with HTTP 400.

- [ ] **Step 5: No commit** (verification only). If a bug is found, fix in the relevant task's file and re-commit there.

---

## Task 7: Wire Reports.tsx (4 tabs) to the service + outlet dropdown

This replaces the data source for the Sales, Item-wise, Stock, and P&L tabs. The Purchase, Expense, Staff, and Waste tabs keep using `useData()` (Phase 2). Charts, cards, and CSV export are unchanged — only the numbers feeding them change.

**Files:**
- Modify: `Ovenisto_Frontend_Software/src/pages/Reports.tsx`

- [ ] **Step 1: Add imports**

At the top of `Reports.tsx`, add:
```ts
import { useQuery } from "@tanstack/react-query";
import { reportService } from "@/services/report.service";
import { outletService } from "@/services/outlet.service";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
```

- [ ] **Step 2: Add outlet state + format dates for the API**

Inside the `Reports` component, after the existing `dateFrom`/`dateTo` state, add:
```ts
const [outletId, setOutletId] = useState<string>("all");

const fromStr = (dateFrom ?? new Date()).toISOString().slice(0, 10);
const toStr = (dateTo ?? new Date()).toISOString().slice(0, 10);
const reportParams = { from: fromStr, to: toStr, outletId };

const { data: outlets = [] } = useQuery({
  queryKey: ["outlets"],
  queryFn: () => outletService.getOutlets(),
});

const { data: salesData } = useQuery({
  queryKey: ["report-sales", reportParams],
  queryFn: () => reportService.getSales(reportParams),
});
const { data: pnlData } = useQuery({
  queryKey: ["report-pnl", reportParams],
  queryFn: () => reportService.getPnl(reportParams),
});
const { data: itemsData } = useQuery({
  queryKey: ["report-items", reportParams],
  queryFn: () => reportService.getItems(reportParams),
});
const { data: stockData } = useQuery({
  queryKey: ["report-stock", reportParams],
  queryFn: () => reportService.getStock(reportParams),
});
```
> Confirm `outletService.getOutlets()` exists; if the method name differs, run `grep -n "export const outletService" -A30 src/services/outlet.service.ts` and use the actual list method.

- [ ] **Step 3: Replace the derived values for the 4 in-scope tabs**

Remove the old `useData()`-derived consts for these four tabs and read from the query data instead. Replace:
- `totalSales` -> `salesData?.totalSales ?? 0`
- `filteredOrders.length` (Total Orders card) -> `salesData?.totalOrders ?? 0`
- avg order value expression -> `salesData?.avgOrderValue ?? 0`
- `revenueChart` -> `salesData?.trend ?? []`
- `itemRevenue` -> `(itemsData?.topItems ?? []).map(i => ({ name: i.name.substring(0,12), revenue: i.revenue }))`
- P&L cards: `totalSales`->`pnlData?.revenue`, `cogs`->`pnlData?.cogs`, `totalExpenses`->`pnlData?.expenses`, `netProfit`->`pnlData?.netProfit`, `expenseByCategory` (in P&L tab) -> `pnlData?.expenseByCategory ?? []`
- Stock tab: `ingredients.length`->`stockData?.totalIngredients ?? 0`, low-stock count->`stockData?.lowStockItems ?? 0`, total value->`stockData?.totalValue ?? 0`, `stockByCategory`->`stockData?.stockByCategory ?? []`

Keep the Purchase/Expense/Staff/Waste tabs exactly as they are (still `useData()`).

- [ ] **Step 4: Add the outlet dropdown to the filter row**

In the `DateRangeFilter` JSX block, add before the preset buttons:
```tsx
<Select value={outletId} onValueChange={setOutletId}>
  <SelectTrigger className="w-[160px] h-8 text-xs"><SelectValue placeholder="Outlet" /></SelectTrigger>
  <SelectContent>
    <SelectItem value="all">All Outlets</SelectItem>
    {outlets.map((o: { id: string; name: string }) => (
      <SelectItem key={o.id} value={o.id}>{o.name}</SelectItem>
    ))}
  </SelectContent>
</Select>
```
> Note: `DateRangeFilter` is currently defined inside the component, so it already closes over `outletId`/`setOutletId`/`outlets`. Keep it inside the component.

- [ ] **Step 5: Add the restaurant-wide expenses note (P&L tab)**

In the P&L tab, where expenses are shown, conditionally render:
```tsx
{pnlData?.expensesAreRestaurantWide && (
  <p className="text-xs text-muted-foreground">Expenses are restaurant-wide (not outlet-specific).</p>
)}
```

- [ ] **Step 6: Typecheck**

Run: `npx tsc --noEmit`
Expected: exit 0. Remove any now-unused `useData()` destructured fields that only the 4 migrated tabs used (e.g. if `foodRecipes` is no longer referenced). Keep fields still used by the other 4 tabs.

- [ ] **Step 7: Build**

Run: `npm run build`
Expected: `vite build` exits 0.

- [ ] **Step 8: Commit**

```bash
git add src/pages/Reports.tsx
git commit -m "Wire Reports.tsx sales/pnl/items/stock tabs to /api/reports + outlet filter"
```

---

## Task 8: Manual UI verification

**Files:** none

- [ ] **Step 1: Run both servers**

Backend: `npm run dev` (port 3001). Frontend: `npm run dev` (port 8080).

- [ ] **Step 2: Open Reports, log in as Super Admin**

Navigate to the Reports page. Set a wide date range (e.g. Jan-Dec 2026).

- [ ] **Step 3: Check each migrated tab**

- Sales: totals + trend chart show real DB numbers (not empty/mock).
- Item-wise: top items list is populated.
- Stock: ingredient count, low-stock, total value match Inventory.
- P&L: netProfit = revenue - cogs - expenses; restaurant-wide note appears when a specific outlet is selected.

- [ ] **Step 4: Toggle the outlet dropdown**

Switch from "All Outlets" to a specific outlet — sales/items/P&L revenue should change; stock stays the same (global in Phase 1).

- [ ] **Step 5: Confirm Phase-2 tabs still work**

Purchase / Expense / Staff / Waste tabs still render (from `useData()`), no crash.

---

## Task 9: Final review + push

- [ ] **Step 1: Run all backend tests + typecheck**

Run (backend): `npm run test && npm run typecheck`
Expected: tests PASS, typecheck exit 0.

- [ ] **Step 2: Frontend typecheck + build**

Run (frontend): `npx tsc --noEmit && npm run build`
Expected: both exit 0.

- [ ] **Step 3: Push both repos (only after user confirms)**

```bash
# backend
cd Ovenisto-backend && git push origin main
# frontend
cd ../Ovenisto_Frontend_Software && git push origin main
```
Railway redeploys the backend; Vercel redeploys the frontend.

---

## Notes for the implementer

- **OrderStatus enum:** the code assumes the completed status literal is `COMPLETED`. Verify with `grep -n "OrderStatus\|COMPLETED" prisma/schema.prisma` before relying on it; adjust the `COMPLETED` const in the controller if the schema uses a different value.
- **Prisma relation filter** (`order: { is: completedWhere }`) in the items endpoint requires the `OrderItem.order` relation to exist (it does). If Prisma rejects the nested `status` typing, cast the where object as in the other endpoints.
- **Decimal -> Number:** every Prisma Decimal (`total`, `price`, `qtyPerUnit`, `purchasePrice`, `currentStock`, `amount`) is wrapped in `Number()` — keep this; raw Decimals break JSON math.
- **Do not touch** the Purchase/Expense/Staff/Waste tabs or `Analytics.tsx` — Phase 2.
```
