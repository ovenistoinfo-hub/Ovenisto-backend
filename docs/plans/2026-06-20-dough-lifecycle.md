# Dough Lifecycle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Track short-shelf-life ingredients (dough = 8 hr): add `Ingredient.shelfLifeHours`, make production create a time-stamped `StockBatch` (consuming other ingredients), expose a dough-batches read API + a per-batch waste API, draw dough down FIFO when orders complete, and show a live countdown widget on the Dashboard.

**Architecture:** Pure helpers (expiry/status/FIFO math) unit-tested first, then the controller endpoints and the production/order extensions, then the two frontend pieces. Expiry is computed from `StockBatch.createdAt + shelfLifeHours` at read time — no stored timestamp, no cron.

**Tech Stack:** Express + TypeScript + Prisma (Neon Postgres) + vitest backend; React 18 + Vite + @tanstack/react-query + shadcn/ui frontend.

**Spec:** `docs/specs/2026-06-20-dough-lifecycle-design.md`

## Global Constraints

- ESM imports use the `.js` extension.
- All Prisma `Decimal` reads -> wrap in `Number(...)`.
- Controllers: `asyncHandler(async (req,res)=>{... res.json(ApiResponse.success(data))})`; errors `throw ApiError.badRequest(msg)`.
- Dough roles: `['Super Admin','Admin','Manager','Store Manager','Kitchen Manager']`.
- Short-life ingredient = `Ingredient.shelfLifeHours != null`. Expiry = `createdAt + shelfLifeHours` (computed). Status: `near-expiry` when `minutesRemaining <= 60`, `expired` when `<= 0`, else `active`.
- FIFO: oldest `StockBatch.createdAt` first; batches floor at 0; never block a sale.
- No cron / background jobs.

**Verified schema facts (already checked):** `StockAdjustment` has `ingredientId, type, quantity, reason, adjustedById, warehouseId, date`. `Ingredient` has `unit` relation (`IngredientUnit?`, has `name`), `purchasePrice`, `currentStock`, `unitId`. `Warehouse` has `type` (WarehouseType enum, e.g. KITCHEN), `outletId`, `isActive`. `WasteRecord` has `itemName, quantity, unit, reason, cost, recordedBy, date`. `StockBatch` has `warehouseId, ingredientId, batchQty, remainingQty, expiryDate (Date?), createdAt`.

---

## File Structure

**Backend:**
- Modify `prisma/schema.prisma` — add `Ingredient.shelfLifeHours Int?`.
- Create `src/modules/stock/dough.helpers.ts` — pure: `computeExpiry`, `minutesRemaining`, `batchStatus`, `fifoDrawdown`.
- Create `src/modules/stock/__tests__/dough.helpers.test.ts` — unit tests.
- Modify `src/modules/stock/stock.controller.ts` — add `getDoughBatches`, `wasteDoughBatch`; extend `createProduction`.
- Modify `src/modules/stock/stock.routes.ts` — add 2 routes + Kitchen Manager role.
- Modify `src/modules/order/order.controller.ts` — FIFO batch drawdown after the per-ingredient decrement loop (~line 408).

**Frontend:**
- Modify `src/services/stock.service.ts` — extend `createProduction` params; add `getDoughBatches`, `wasteDoughBatch`, `DoughBatch` type.
- Modify `src/services/inventory.service.ts` — add `shelfLifeHours?: number | null` to `IngredientRecord` (if referenced by the form).
- Modify `src/pages/Production.tsx` — add the produce-dough form.
- Modify `src/pages/Dashboard.tsx` — add the live-countdown widget.

---

## Task 1: Schema — `Ingredient.shelfLifeHours`

**Files:** Modify `prisma/schema.prisma`

**Interfaces:**
- Produces: `Ingredient.shelfLifeHours: number | null` on the Prisma client.

- [ ] **Step 1: Add the field**

In `prisma/schema.prisma`, in the `Ingredient` model, after the `status String @default("active") ...` line add:
```prisma
  shelfLifeHours Int?     // null = normal; set (e.g. 8) = short-life ingredient (dough) with batch + countdown tracking
```

- [ ] **Step 2: Generate client + push**

```bash
cd "e:/Sir Kazmi/ovenisto-flame-kissed-flavor/Ovenisto-backend"
npx prisma format
npx prisma generate
npx prisma db push   # additive column, no data loss
```
Expected: "Your database is now in sync with your Prisma schema."

- [ ] **Step 3: Typecheck + commit**

```bash
npm run typecheck   # exit 0
git add prisma/schema.prisma
git commit -m "Add Ingredient.shelfLifeHours for short-life (dough) tracking"
```

---

## Task 2: Dough pure helpers (TDD)

**Files:**
- Create: `src/modules/stock/dough.helpers.ts`
- Test: `src/modules/stock/__tests__/dough.helpers.test.ts`

**Interfaces:**
- Produces:
  - `computeExpiry(createdAt: Date, shelfLifeHours: number): Date`
  - `minutesRemaining(expiresAt: Date, now: Date): number`  (floors at 0)
  - `batchStatus(expiresAt: Date, now: Date): 'active'|'near-expiry'|'expired'`
  - `fifoDrawdown(batches: {id:string; remainingQty:number}[], qty: number): {id:string; newRemaining:number}[]`

- [ ] **Step 1: Write the failing tests**

Create `src/modules/stock/__tests__/dough.helpers.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { computeExpiry, minutesRemaining, batchStatus, fifoDrawdown } from '../dough.helpers.js';

describe('computeExpiry', () => {
  it('adds shelfLifeHours to createdAt', () => {
    expect(computeExpiry(new Date('2026-06-20T09:00:00.000Z'), 8).toISOString())
      .toBe('2026-06-20T17:00:00.000Z');
  });
});

describe('minutesRemaining', () => {
  it('returns whole minutes until expiry', () => {
    expect(minutesRemaining(new Date('2026-06-20T17:00:00.000Z'), new Date('2026-06-20T15:30:00.000Z'))).toBe(90);
  });
  it('floors at 0 when already expired', () => {
    expect(minutesRemaining(new Date('2026-06-20T17:00:00.000Z'), new Date('2026-06-20T18:00:00.000Z'))).toBe(0);
  });
});

describe('batchStatus', () => {
  const exp = new Date('2026-06-20T17:00:00.000Z');
  it('active when more than 60 min left', () => {
    expect(batchStatus(exp, new Date('2026-06-20T15:00:00.000Z'))).toBe('active');
  });
  it('near-expiry at exactly 60 min', () => {
    expect(batchStatus(exp, new Date('2026-06-20T16:00:00.000Z'))).toBe('near-expiry');
  });
  it('expired at exactly 0', () => {
    expect(batchStatus(exp, new Date('2026-06-20T17:00:00.000Z'))).toBe('expired');
  });
  it('expired when past', () => {
    expect(batchStatus(exp, new Date('2026-06-20T18:00:00.000Z'))).toBe('expired');
  });
});

describe('fifoDrawdown', () => {
  it('draws from oldest first, flooring each at 0', () => {
    const batches = [
      { id: 'a', remainingQty: 3 }, // caller passes oldest-first
      { id: 'b', remainingQty: 5 },
    ];
    expect(fifoDrawdown(batches, 4)).toEqual([
      { id: 'a', newRemaining: 0 },
      { id: 'b', newRemaining: 4 },
    ]);
  });
  it('only touches batches it draws from', () => {
    const batches = [{ id: 'a', remainingQty: 10 }, { id: 'b', remainingQty: 5 }];
    expect(fifoDrawdown(batches, 4)).toEqual([{ id: 'a', newRemaining: 6 }]);
  });
  it('drains all and stops when qty exceeds available', () => {
    const batches = [{ id: 'a', remainingQty: 2 }, { id: 'b', remainingQty: 1 }];
    expect(fifoDrawdown(batches, 10)).toEqual([
      { id: 'a', newRemaining: 0 },
      { id: 'b', newRemaining: 0 },
    ]);
  });
});
```

- [ ] **Step 2: Run tests, verify FAIL**

Run: `npm run test`
Expected: FAIL — `../dough.helpers.js` not found.

- [ ] **Step 3: Implement**

Create `src/modules/stock/dough.helpers.ts`:
```ts
/** Expiry = made-at + shelf life (hours). */
export function computeExpiry(createdAt: Date, shelfLifeHours: number): Date {
  return new Date(createdAt.getTime() + shelfLifeHours * 60 * 60 * 1000);
}

/** Whole minutes from now until expiry; floored at 0. */
export function minutesRemaining(expiresAt: Date, now: Date): number {
  const ms = expiresAt.getTime() - now.getTime();
  return ms <= 0 ? 0 : Math.floor(ms / 60000);
}

/** active (>60 min) | near-expiry (<=60 min, >0) | expired (<=0). */
export function batchStatus(expiresAt: Date, now: Date): 'active' | 'near-expiry' | 'expired' {
  const mins = (expiresAt.getTime() - now.getTime()) / 60000;
  if (mins <= 0) return 'expired';
  if (mins <= 60) return 'near-expiry';
  return 'active';
}

/**
 * Draw `qty` down across batches in the given order (caller passes oldest-first).
 * Returns only the batches actually touched, with their new remaining (floored at 0).
 */
export function fifoDrawdown(
  batches: { id: string; remainingQty: number }[],
  qty: number
): { id: string; newRemaining: number }[] {
  const out: { id: string; newRemaining: number }[] = [];
  let need = qty;
  for (const b of batches) {
    if (need <= 0) break;
    const take = Math.min(b.remainingQty, need);
    out.push({ id: b.id, newRemaining: b.remainingQty - take });
    need -= take;
  }
  return out;
}
```

- [ ] **Step 4: Run tests, verify PASS**

Run: `npm run test`
Expected: PASS — all existing + new tests green.

- [ ] **Step 5: Typecheck + commit**

```bash
npm run typecheck   # exit 0
git add src/modules/stock/dough.helpers.ts src/modules/stock/__tests__/dough.helpers.test.ts
git commit -m "Add dough helpers (expiry, status, FIFO drawdown) with tests"
```

---

## Task 3: Extend `createProduction` to make a dough batch

**Files:** Modify `src/modules/stock/stock.controller.ts`

**Interfaces:**
- Consumes: existing `createProduction` (~line 246) which runs a `prisma.$transaction`.
- Produces: `createProduction` now also handles `producedIngredientId`, `consumedIngredients`, `warehouseId`.

- [ ] **Step 1: Extend the handler**

In `src/modules/stock/stock.controller.ts`, find `export const createProduction` (~line 246). Replace the whole handler with:
```ts
/** POST /api/stock/productions */
export const createProduction = asyncHandler(async (req: Request, res: Response) => {
  const {
    itemName, quantity, unit, notes, menuItemId, deductIngredients,
    producedIngredientId, consumedIngredients, warehouseId,
  } = req.body;

  if (!itemName?.trim()) throw ApiError.badRequest('Item name is required');
  if (!quantity || Number(quantity) <= 0) throw ApiError.badRequest('Quantity must be greater than 0');

  const production = await prisma.$transaction(async (tx) => {
    const prod = await tx.production.create({
      data: {
        itemName: itemName.trim(),
        quantity: Number(quantity),
        unit: unit || null,
        producedBy: req.user?.name || null,
        date: new Date(),
        notes: notes || null,
      },
    });

    // Path A (existing): deduct a menu item's recipe ingredients.
    if (menuItemId && deductIngredients) {
      const recipes = await tx.foodRecipe.findMany({
        where: { menuItemId },
        include: { ingredient: true },
      });
      for (const recipe of recipes) {
        const required = Number(recipe.qtyPerUnit) * Number(quantity);
        await tx.ingredient.update({
          where: { id: recipe.ingredientId },
          data: { currentStock: { increment: -required } },
        });
      }
    }

    // Path B (new): produce a short-life ingredient (dough). Consume picked ingredients,
    // add the produced stock, and create a time-stamped StockBatch (the 8-hr clock starts now).
    if (producedIngredientId) {
      let whId: string | null = warehouseId || null;
      if (!whId) {
        const kw = await tx.warehouse.findFirst({ where: { type: 'KITCHEN', isActive: true }, select: { id: true } });
        whId = kw?.id ?? null;
      }
      if (!whId) throw ApiError.badRequest('No kitchen warehouse found to store the produced batch');

      if (Array.isArray(consumedIngredients)) {
        for (const c of consumedIngredients) {
          if (!c?.ingredientId || !c?.qty) continue;
          await tx.ingredient.update({
            where: { id: c.ingredientId },
            data: { currentStock: { decrement: Number(c.qty) } },
          });
        }
      }

      await tx.ingredient.update({
        where: { id: producedIngredientId },
        data: { currentStock: { increment: Number(quantity) } },
      });

      await tx.stockBatch.create({
        data: {
          warehouseId: whId,
          ingredientId: producedIngredientId,
          batchQty: Number(quantity),
          remainingQty: Number(quantity),
          expiryDate: null, // derived from shelfLifeHours, not stored
        },
      });

      await tx.stockAdjustment.create({
        data: {
          ingredientId: producedIngredientId,
          type: 'produce',
          quantity: Number(quantity),
          reason: `Produced ${itemName.trim()}`,
          adjustedById: req.user?.id ?? null,
          warehouseId: whId,
          date: new Date(),
        },
      });
    }

    return prod;
  }, { timeout: 60000 });

  res.status(201).json(ApiResponse.created(production, 'Production recorded'));
});
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: exit 0. (`type: 'KITCHEN'` is a WarehouseType enum value — if Prisma rejects the bare string, cast `type: 'KITCHEN' as never` like the order controller does for enums.)

- [ ] **Step 3: Commit**

```bash
git add src/modules/stock/stock.controller.ts
git commit -m "Extend createProduction to make a short-life ingredient batch"
```

---

## Task 4: Dough-batches read API + waste API

**Files:** Modify `src/modules/stock/stock.controller.ts`

**Interfaces:**
- Consumes: `computeExpiry`, `minutesRemaining`, `batchStatus` from `dough.helpers.js`.
- Produces: `getDoughBatches`, `wasteDoughBatch`.

- [ ] **Step 1: Import the helpers**

At the top of `src/modules/stock/stock.controller.ts`, after the existing imports add:
```ts
import { computeExpiry, minutesRemaining, batchStatus } from './dough.helpers.js';
```

- [ ] **Step 2: Append the two handlers at the END of the file**

```ts
// ============================================================
// DOUGH / SHORT-LIFE BATCHES
// ============================================================

/** GET /api/stock/dough-batches?outletId=<id|all> */
export const getDoughBatches = asyncHandler(async (req: Request, res: Response) => {
  const outletId = req.query.outletId as string | undefined;
  const now = new Date();

  const batches = await prisma.stockBatch.findMany({
    where: {
      remainingQty: { gt: 0 },
      ingredient: { shelfLifeHours: { not: null } },
      ...(outletId && outletId !== 'all' ? { warehouse: { outletId } } : {}),
    },
    select: {
      id: true, ingredientId: true, remainingQty: true, createdAt: true,
      ingredient: { select: { name: true, shelfLifeHours: true, unit: { select: { name: true } } } },
    },
    orderBy: { createdAt: 'asc' },
  });

  const rows = batches.map((b) => {
    const expiresAt = computeExpiry(b.createdAt, b.ingredient.shelfLifeHours as number);
    return {
      id: b.id,
      ingredientId: b.ingredientId,
      ingredientName: b.ingredient.name,
      unit: b.ingredient.unit?.name ?? null,
      remainingQty: Number(b.remainingQty),
      madeAt: b.createdAt.toISOString(),
      expiresAt: expiresAt.toISOString(),
      minutesRemaining: minutesRemaining(expiresAt, now),
      status: batchStatus(expiresAt, now),
    };
  });
  rows.sort((a, b) => new Date(a.expiresAt).getTime() - new Date(b.expiresAt).getTime());

  res.json(ApiResponse.success(rows));
});

/** POST /api/stock/dough-batches/:id/waste */
export const wasteDoughBatch = asyncHandler(async (req: Request, res: Response) => {
  const { id } = req.params;

  const waste = await prisma.$transaction(async (tx) => {
    const batch = await tx.stockBatch.findUnique({
      where: { id },
      select: {
        remainingQty: true, ingredientId: true,
        ingredient: { select: { name: true, purchasePrice: true, unit: { select: { name: true } } } },
      },
    });
    if (!batch) throw ApiError.notFound('Batch not found');
    const remaining = Number(batch.remainingQty);
    if (remaining <= 0) throw ApiError.badRequest('Batch already empty');

    await tx.ingredient.update({
      where: { id: batch.ingredientId },
      data: { currentStock: { decrement: remaining } },
    });
    await tx.stockBatch.update({ where: { id }, data: { remainingQty: 0 } });

    return tx.wasteRecord.create({
      data: {
        itemName: batch.ingredient.name,
        quantity: remaining,
        unit: batch.ingredient.unit?.name ?? null,
        cost: Number(batch.ingredient.purchasePrice ?? 0) * remaining,
        reason: 'Expired (short shelf life)',
        recordedBy: req.user?.name ?? null,
        date: new Date(),
      },
    });
  });

  res.status(201).json(ApiResponse.created(waste, 'Batch wasted'));
});
```

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: exit 0.

- [ ] **Step 4: Commit**

```bash
git add src/modules/stock/stock.controller.ts
git commit -m "Add dough-batches read API + per-batch waste API"
```

---

## Task 5: Mount the routes (+ Kitchen Manager role)

**Files:** Modify `src/modules/stock/stock.routes.ts`

- [ ] **Step 1: Edit the routes file**

In `src/modules/stock/stock.routes.ts`:
- Add `getDoughBatches, wasteDoughBatch` to the import list from `./stock.controller.js`.
- Change `const stockRoles = ['Super Admin', 'Admin', 'Manager', 'Store Manager'];` to add Kitchen Manager:
```ts
const stockRoles = ['Super Admin', 'Admin', 'Manager', 'Store Manager', 'Kitchen Manager'];
```
- Before `export default router;`, add:
```ts
// ── Dough / Short-Life Batches ──
router.get('/dough-batches', authenticate, authorize(stockRoles), getDoughBatches);
router.post('/dough-batches/:id/waste', authenticate, authorize(stockRoles), wasteDoughBatch);
```

- [ ] **Step 2: Typecheck + tests**

Run: `npm run typecheck && npm run test`
Expected: typecheck exit 0; all tests pass.

- [ ] **Step 3: Commit**

```bash
git add src/modules/stock/stock.routes.ts
git commit -m "Mount dough-batches routes + allow Kitchen Manager on stock"
```

---

## Task 6: FIFO batch drawdown on order completion

**Files:** Modify `src/modules/order/order.controller.ts`

**Interfaces:**
- Consumes: `fifoDrawdown` from `dough.helpers.js`.
- Produces: short-life ingredients' `StockBatch.remainingQty` stays in sync with sales.

- [ ] **Step 1: Import the helper**

At the top of `src/modules/order/order.controller.ts`, add:
```ts
import { fifoDrawdown } from '../stock/dough.helpers.js';
```

- [ ] **Step 2: Add FIFO drawdown after the per-ingredient decrement loop**

Read lines 380-415 of `src/modules/order/order.controller.ts` first to confirm scope. The deduction `for (const [ingredientId, qty] of deductionEntries)` loop closes around line 408. INSIDE the same `tx` transaction, immediately after that loop's closing brace, add:
```ts
        // For short-life ingredients (dough), keep their StockBatch.remainingQty in sync
        // by drawing the sold qty down FIFO (oldest batch first). Sale is never blocked.
        if (deductionEntries.length > 0) {
          const shortLife = await tx.ingredient.findMany({
            where: { id: { in: deductionEntries.map(([id]) => id) }, shelfLifeHours: { not: null } },
            select: { id: true },
          });
          const shortLifeIds = new Set(shortLife.map((i) => i.id));
          for (const [ingredientId, qty] of deductionEntries) {
            if (!shortLifeIds.has(ingredientId)) continue;
            const batches = await tx.stockBatch.findMany({
              where: { ingredientId, remainingQty: { gt: 0 } },
              select: { id: true, remainingQty: true },
              orderBy: { createdAt: 'asc' },
            });
            const draws = fifoDrawdown(
              batches.map((b) => ({ id: b.id, remainingQty: Number(b.remainingQty) })),
              qty
            );
            for (const d of draws) {
              await tx.stockBatch.update({ where: { id: d.id }, data: { remainingQty: d.newRemaining } });
            }
          }
        }
```

- [ ] **Step 3: Typecheck + tests**

Run: `npm run typecheck && npm run test`
Expected: exit 0; tests pass.

- [ ] **Step 4: Commit**

```bash
git add src/modules/order/order.controller.ts
git commit -m "Draw short-life ingredient batches down FIFO on order completion"
```

---

## Task 7: Verify backend against live DB

**Files:** none (manual).

- [ ] **Step 1: Start backend + log in** (`npm run dev`; token via `/api/auth/login` admin@ovenisto.com / password123).
- [ ] **Step 2: Mark an ingredient short-life.** Get an ingredient id (`GET /api/inventory/ingredients`), then in Prisma Studio (`npm run db:studio`) set its `shelfLifeHours = 8`.
- [ ] **Step 3: Produce a dough batch:**
```bash
curl -s -X POST http://localhost:3001/api/stock/productions -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"itemName":"Pizza Dough","quantity":8,"unit":"kg","producedIngredientId":"<dough-id>","consumedIngredients":[]}' | python -m json.tool
```
- [ ] **Step 4: Read dough batches:**
```bash
curl -s "http://localhost:3001/api/stock/dough-batches?outletId=all" -H "Authorization: Bearer $TOKEN" | python -m json.tool
```
Expected: one row, `status:"active"`, `minutesRemaining` ~479-480, `expiresAt` ~8h after `madeAt`.
- [ ] **Step 5: Waste it:**
```bash
curl -s -X POST http://localhost:3001/api/stock/dough-batches/<batch-id>/waste -H "Authorization: Bearer $TOKEN" | python -m json.tool
```
Expected: a WasteRecord returned; re-reading dough-batches no longer lists it; a second waste call returns `400 Batch already empty`.
- [ ] **Step 6: No commit** (verification only; fix in the owning task if a bug appears).

---

## Task 8: Frontend stock service

**Files:** Modify `Ovenisto_Frontend_Software/src/services/stock.service.ts`

**Interfaces:**
- Produces: `DoughBatch` type; `stockService.getDoughBatches`, `stockService.wasteDoughBatch`; extended `createProduction` params.

- [ ] **Step 1: Extend createProduction + add type and methods**

In `src/services/stock.service.ts`, change the `createProduction` signature to:
```ts
  async createProduction(data: {
    itemName: string; quantity: number; unit?: string; notes?: string;
    menuItemId?: string; deductIngredients?: boolean;
    producedIngredientId?: string;
    consumedIngredients?: { ingredientId: string; qty: number }[];
    warehouseId?: string;
  }): Promise<ProductionRecord> {
    const res = await api.post<{ success: boolean; data: ProductionRecord }>('/stock/productions', data);
    return res.data;
  },
```
Add a `DoughBatch` interface (near the other exported interfaces):
```ts
export interface DoughBatch {
  id: string;
  ingredientId: string;
  ingredientName: string;
  unit: string | null;
  remainingQty: number;
  madeAt: string;
  expiresAt: string;
  minutesRemaining: number;
  status: 'active' | 'near-expiry' | 'expired';
}
```
Add two methods inside the `stockService` object:
```ts
  async getDoughBatches(params?: { outletId?: string }): Promise<DoughBatch[]> {
    const q = new URLSearchParams();
    q.set('outletId', params?.outletId && params.outletId !== 'all' ? params.outletId : 'all');
    const res = await api.get<{ success: boolean; data: DoughBatch[] }>(`/stock/dough-batches?${q.toString()}`);
    return res.data;
  },
  async wasteDoughBatch(id: string): Promise<void> {
    await api.post(`/stock/dough-batches/${id}/waste`, {});
  },
```

- [ ] **Step 2: Typecheck + commit**

```bash
cd "e:/Sir Kazmi/ovenisto-flame-kissed-flavor/Ovenisto_Frontend_Software"
npx tsc --noEmit   # exit 0
git add src/services/stock.service.ts
git commit -m "Add dough-batch service methods + extend createProduction params"
```

---

## Task 9: Production page — produce-dough form

**Files:** Modify `src/pages/Production.tsx`, and `src/services/inventory.service.ts` (add `shelfLifeHours`).

**Interfaces:**
- Consumes: `stockService.createProduction` (extended), `inventoryService.getIngredients`.

- [ ] **Step 1: Add shelfLifeHours to IngredientRecord (if used to filter)**

In `src/services/inventory.service.ts`, add to the `IngredientRecord` interface:
```ts
  shelfLifeHours?: number | null;
```

- [ ] **Step 2: Add a dough-production form to Production.tsx**

Read `Production.tsx` fully first (it has a `form` state and an inline add panel with a menu-item path). Add:
- `import { inventoryService, type IngredientRecord } from "@/services/inventory.service";`
- Load ingredients into state on mount (alongside the existing menu-items load): `inventoryService.getIngredients({ status: 'active' })` -> `setIngredients(...)`.
- Dough form state: `const [doughForm, setDoughForm] = useState<{ producedIngredientId: string; quantity: number; unit: string; consumed: { ingredientId: string; qty: number }[] }>({ producedIngredientId: "", quantity: 0, unit: "", consumed: [] });` and `const [showDough, setShowDough] = useState(false);`
- A "Produce Dough" button that toggles `showDough`, revealing an inline Card form with: a Select for `producedIngredientId` (options = `ingredients.filter(i => i.shelfLifeHours != null)`; if that list is empty, fall back to all `ingredients` so it's usable before any ingredient is marked), a quantity number input, a unit text input, and a repeatable consumed list — each row a Select (any ingredient) + qty input, plus an "Add ingredient" button (`setDoughForm(p => ({...p, consumed: [...p.consumed, { ingredientId: '', qty: 0 }]}))`).
- Submit handler:
```ts
const submitDough = async () => {
  if (!doughForm.producedIngredientId || doughForm.quantity <= 0) { toast.error("Select the dough item and a quantity"); return; }
  try {
    await stockService.createProduction({
      itemName: ingredients.find(i => i.id === doughForm.producedIngredientId)?.name || "Dough",
      quantity: doughForm.quantity,
      unit: doughForm.unit || undefined,
      producedIngredientId: doughForm.producedIngredientId,
      consumedIngredients: doughForm.consumed.filter(c => c.ingredientId && c.qty > 0),
    });
    toast.success("Dough produced — batch created with shelf-life clock started");
    setShowDough(false);
    setDoughForm({ producedIngredientId: "", quantity: 0, unit: "", consumed: [] });
    // refresh the productions list (call whatever the page uses, e.g. fetchData())
  } catch (e: any) { toast.error(e.message || "Failed to produce dough"); }
};
```
Keep the existing menu-item production path untouched.

- [ ] **Step 3: Typecheck + build**

```bash
npx tsc --noEmit   # exit 0
npm run build      # exit 0
```

- [ ] **Step 4: Commit**

```bash
git add src/pages/Production.tsx src/services/inventory.service.ts
git commit -m "Production page: add produce-dough form (consumed ingredients + qty)"
```

---

## Task 10: Dashboard — live dough countdown widget

**Files:** Modify `src/pages/Dashboard.tsx`

**Interfaces:**
- Consumes: `stockService.getDoughBatches`, `stockService.wasteDoughBatch`, the existing `outletId` state + `useVisiblePolling`.

- [ ] **Step 1: Add the widget**

In `src/pages/Dashboard.tsx`:
- Imports: `import { stockService } from "@/services/stock.service";`, `import { useVisiblePolling } from "@/hooks/use-visible-polling";`, `import { useEffect } from "react";` (keep the existing `useState` import from the outlet switcher), `import { Button } from "@/components/ui/button";`, `import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from "@/components/ui/alert-dialog";`, and add `Clock` to the existing lucide-react import.
- After the existing dashboard query, add:
```ts
const { data: doughBatches = [], refetch: refetchDough } = useQuery({
  queryKey: ["dough-batches", outletId],
  queryFn: () => stockService.getDoughBatches({ outletId }),
});
useVisiblePolling(() => { refetchDough(); }, 30000);
const [, setTick] = useState(0);
useEffect(() => { const t = setInterval(() => setTick((n) => n + 1), 60000); return () => clearInterval(t); }, []);
const liveMins = (expiresAt: string) => { const ms = new Date(expiresAt).getTime() - Date.now(); return ms <= 0 ? 0 : Math.floor(ms / 60000); };
const fmtLeft = (m: number) => `${Math.floor(m / 60)}h ${m % 60}m left`;
const wasteBatch = async (id: string) => { await stockService.wasteDoughBatch(id); refetchDough(); };
```
- Render a Card titled "Dough / Short-Life Batches" (place it right after the channels section, before payments). The body maps `doughBatches`; for each `b`: `const m = liveMins(b.expiresAt); const st = m <= 0 ? 'expired' : m <= 60 ? 'near-expiry' : 'active';` then a row with the ingredient name + `${b.remainingQty} ${b.unit ?? ''}`, the countdown (`st === 'expired' ? 'EXPIRED' : fmtLeft(m)`) coloured `text-destructive` / `text-warning` / `text-success`, and when `st === 'expired'` an AlertDialog-wrapped destructive `Button` "Waste" whose action calls `wasteBatch(b.id)`. When `doughBatches.length === 0`, show a muted "No active dough batches".

- [ ] **Step 2: Typecheck + build**

```bash
npx tsc --noEmit   # exit 0
npm run build      # exit 0
```

- [ ] **Step 3: Commit**

```bash
git add src/pages/Dashboard.tsx
git commit -m "Dashboard: live dough countdown widget with waste action"
```

---

## Task 11: Manual UI verification

**Files:** none.

- [ ] **Step 1:** Run both servers. Ensure an ingredient has `shelfLifeHours=8` (from Task 7).
- [ ] **Step 2:** Production page -> "Produce Dough" -> pick the dough ingredient, qty 8, add a consumed ingredient -> submit -> success toast.
- [ ] **Step 3:** Dashboard -> "Dough / Short-Life Batches" card shows the batch with a live "Xh Ym left" countdown (green). The outlet switcher scopes it.
- [ ] **Step 4:** (See expiry) In Studio set the batch's `createdAt` to ~9 hours ago -> reload dashboard -> row turns red "EXPIRED" with a Waste button -> click -> confirm -> row disappears and a WasteRecord appears on the Waste page.

---

## Task 12: Final review + push (with user consent)

- [ ] **Step 1:** `cd Ovenisto-backend && npm run test && npm run typecheck` -> tests pass, exit 0.
- [ ] **Step 2:** `cd Ovenisto_Frontend_Software && npx tsc --noEmit && npm run build` -> both exit 0.
- [ ] **Step 3:** Push both repos (ONLY after the user confirms). Railway redeploys backend (its boot runs `prisma db push`, so `shelfLifeHours` ships automatically); Vercel redeploys frontend.

---

## Notes for the implementer

- Expiry is NEVER stored — always `computeExpiry(batch.createdAt, ingredient.shelfLifeHours)`. Leave `StockBatch.expiryDate` null for dough.
- The order-completion change (Task 6) is on a hot path inside an existing transaction — land it in the correct `tx` scope (read lines 380-415 first) without disturbing the existing decrement loop.
- No cron. The dashboard countdown is pure client-side math off `expiresAt`, refreshed by a 1-min tick + a 30s visibility-gated poll.
- Keep all Decimal reads wrapped in `Number()`.
