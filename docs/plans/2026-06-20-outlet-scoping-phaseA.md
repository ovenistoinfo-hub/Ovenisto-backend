# Outlet Scoping — Phase A (Foundation) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a global active-outlet concept — a header selector (Super Admin = any/All, others locked to their outlet) and backend enforcement — applied to the endpoints that already carry `outletId` (Orders, Warehouses, Reports, Dashboard).

**Architecture:** A pure backend helper `resolveOutletScope(req)` derives the effective outlet filter from role + an `X-Outlet-Id` header (non-super-admins are forced to their own outlet). On the frontend, a module-level `outletStore` feeds the header into every request through the single `api.ts` choke-point and folds the outlet into the GET cache key; an `OutletContext` drives a header `Select` and keeps `outletStore` in sync. No schema changes — Phase A only touches columns that already exist.

**Tech Stack:** Express + TypeScript + Prisma (backend, ESM with `.js` import extensions, vitest); React 18 + Vite + TS + Tailwind + shadcn/ui + @tanstack/react-query (frontend).

## Global Constraints

- Super Admin role string is exactly `'Super Admin'`.
- The "all outlets" sentinel value is exactly `'all'`.
- `resolveOutletScope` returns `null` (no outlet filter — Super Admin on "All") or an outlet id string (restrict to that outlet).
- Create-on-"All" error message is exactly: `Select a specific outlet before creating`.
- The create-block applies ONLY when `req.user.role === 'Super Admin'` AND scope is `null`. A non-super-admin is never blocked (preserves today's behavior for users without an assigned outlet).
- Request header name is `X-Outlet-Id`; read it lowercased from `req.headers['x-outlet-id']` (Express lowercases incoming header keys).
- Frontend localStorage key is exactly `ovenisto_selected_outlet`.
- Backend ESM: import local modules with the `.js` extension.
- Backend tests: vitest, files under a `__tests__/` folder named `*.test.ts`; run with `npm run test`.
- All work happens on the `main` branch of each repo; commits stay LOCAL (do not push) until the user explicitly says push.
- Do NOT mention Claude / AI in commit messages.

---

## File Structure

**Backend (`Ovenisto-backend/`):**
- Create: `src/middleware/outletScope.ts` — the `resolveOutletScope` helper (one responsibility: derive the outlet filter from a request).
- Create: `src/middleware/__tests__/outletScope.test.ts` — unit tests for the helper.
- Modify: `src/modules/order/order.controller.ts` — `getOrders` list filter + `createOrder` stamp/guard.
- Modify: `src/modules/warehouse/warehouse.controller.ts` — `getWarehouses` list filter.
- Modify: `src/modules/reports/reports.controller.ts` — route `getParams` + `getDashboard` through the helper.

**Frontend (`Ovenisto_Frontend_Software/`):**
- Create: `src/services/outletStore.ts` — module-level holder for the active outlet id.
- Create: `src/services/__tests__/outletStore.test.ts` — unit test for the holder.
- Create: `src/contexts/OutletContext.tsx` — global context + `useOutlet()` hook.
- Modify: `src/services/api.ts` — inject `X-Outlet-Id`, fold outlet into the cache key, fix `invalidateCache`.
- Modify: `src/App.tsx` — wrap the app in `OutletProvider`.
- Modify: `src/components/layout/AppHeader.tsx` — the outlet `Select`.
- Modify: `src/contexts/AuthContext.tsx` — clear the stored outlet on logout.

**Task order:** Backend Tasks 1→3 are independent of the frontend. Frontend Task 4 (`outletStore` + `api.ts`) is the foundation for Task 5 (context), which is the foundation for Task 6 (header). Within the frontend, do 4→5→6 in order.

---

## Task 1: Backend `resolveOutletScope` helper + tests

**Files:**
- Create: `src/middleware/outletScope.ts`
- Test: `src/middleware/__tests__/outletScope.test.ts`

**Interfaces:**
- Consumes: Express `Request` (with the project's `req.user` augmentation: `{ id, role, outletId?: string | null }`).
- Produces: `resolveOutletScope(req: Request): string | null` — `null` = no outlet filter (Super Admin viewing "All"); a string = restrict to that outlet.

- [ ] **Step 1: Write the failing test**

Create `src/middleware/__tests__/outletScope.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import type { Request } from 'express';
import { resolveOutletScope } from '../outletScope.js';

function mockReq(opts: {
  role?: string;
  userOutletId?: string | null;
  headerOutlet?: string;
  queryOutlet?: string;
}): Request {
  return {
    headers: opts.headerOutlet !== undefined ? { 'x-outlet-id': opts.headerOutlet } : {},
    query: opts.queryOutlet !== undefined ? { outletId: opts.queryOutlet } : {},
    user: opts.role !== undefined ? { id: 'u1', role: opts.role, outletId: opts.userOutletId ?? null } : undefined,
  } as unknown as Request;
}

describe('resolveOutletScope', () => {
  it('Super Admin with no header → null (see everything)', () => {
    expect(resolveOutletScope(mockReq({ role: 'Super Admin' }))).toBeNull();
  });

  it('Super Admin with header "all" → null', () => {
    expect(resolveOutletScope(mockReq({ role: 'Super Admin', headerOutlet: 'all' }))).toBeNull();
  });

  it('Super Admin with header "o1" → "o1"', () => {
    expect(resolveOutletScope(mockReq({ role: 'Super Admin', headerOutlet: 'o1' }))).toBe('o1');
  });

  it('Manager is forced to own outlet, ignoring a foreign header', () => {
    expect(resolveOutletScope(mockReq({ role: 'Manager', userOutletId: 'o1', headerOutlet: 'o2' }))).toBe('o1');
  });

  it('Manager with no header → own outlet', () => {
    expect(resolveOutletScope(mockReq({ role: 'Manager', userOutletId: 'o1' }))).toBe('o1');
  });

  it('Manager with no assigned outlet → null (documented edge)', () => {
    expect(resolveOutletScope(mockReq({ role: 'Manager', userOutletId: null }))).toBeNull();
  });

  it('falls back to the query param when no header is present (Super Admin)', () => {
    expect(resolveOutletScope(mockReq({ role: 'Super Admin', queryOutlet: 'o3' }))).toBe('o3');
  });

  it('no user on request → null', () => {
    expect(resolveOutletScope(mockReq({}))).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd Ovenisto-backend && npx vitest run src/middleware/__tests__/outletScope.test.ts`
Expected: FAIL — cannot find module `../outletScope.js` / `resolveOutletScope is not a function`.

- [ ] **Step 3: Write the helper**

Create `src/middleware/outletScope.ts`:

```ts
import type { Request } from 'express';

/**
 * Derives the effective outlet filter for a request.
 *
 *   null   → no outlet filter (Super Admin viewing "All Outlets")
 *   string → restrict to this outlet id
 *
 * Super Admin may target any outlet via the `X-Outlet-Id` header (or
 * `?outletId=`); the value `'all'` (or no value) means "see everything".
 * Every other role is FORCED to their own `user.outletId` — any client-sent
 * outlet value is ignored, so a non-super-admin cannot read or write another
 * branch's data.
 */
export function resolveOutletScope(req: Request): string | null {
  const rawHeader = req.headers['x-outlet-id'];
  const headerVal = Array.isArray(rawHeader) ? rawHeader[0] : rawHeader;
  const rawQuery = req.query?.outletId;
  const queryVal = typeof rawQuery === 'string' ? rawQuery : undefined;
  const requested = headerVal || queryVal;

  const role = req.user?.role;
  if (role === 'Super Admin') {
    if (!requested || requested === 'all') return null;
    return requested;
  }
  // Everyone else: pinned to their own outlet (header ignored).
  return req.user?.outletId ?? null;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd Ovenisto-backend && npx vitest run src/middleware/__tests__/outletScope.test.ts`
Expected: PASS — 8 passed.

- [ ] **Step 5: Run the full suite + typecheck (no regressions)**

Run: `cd Ovenisto-backend && npm run test && npm run typecheck`
Expected: all tests pass (existing dough/reports tests + the 8 new ones); typecheck exits 0.

- [ ] **Step 6: Commit**

```bash
cd Ovenisto-backend
git add src/middleware/outletScope.ts src/middleware/__tests__/outletScope.test.ts
git commit -m "Add resolveOutletScope helper for role-based outlet enforcement"
```

---

## Task 2: Apply scope to Orders (list filter + create stamp/guard)

**Files:**
- Modify: `src/modules/order/order.controller.ts` (`getOrders` ~line 94-120; `createOrder` ~line 164-220)

**Interfaces:**
- Consumes: `resolveOutletScope(req): string | null` from Task 1.
- Produces: orders list filtered by scope; new orders stamped with `outletId`.

- [ ] **Step 1: Import the helper**

At the top of `src/modules/order/order.controller.ts`, with the other imports, add:

```ts
import { resolveOutletScope } from '../../middleware/outletScope.js';
```

- [ ] **Step 2: Filter the orders list by scope**

In `getOrders`, the code builds `const where: any = {};` (around line 98) and then adds `status`/`type`/`date`/`tableNumber`/`orderSource` filters. Immediately AFTER `const where: any = {};`, add the outlet filter:

```ts
  const where: any = {};
  // Outlet scope: Super Admin on "All" → no filter; otherwise restrict to the resolved outlet.
  const scope = resolveOutletScope(req);
  if (scope) where.outletId = scope;
```

Leave the rest of the `getOrders` filters unchanged.

- [ ] **Step 3: Stamp + guard outlet on create**

In `createOrder`, just BEFORE the `const order = await prisma.order.create({` call (around line 179), resolve the scope and apply the guard:

```ts
  // Outlet scope: stamp the order's outlet. Block only a Super Admin sitting on
  // "All Outlets" (scope === null) — they must pick a specific outlet to create.
  const scope = resolveOutletScope(req);
  if (scope === null && req.user?.role === 'Super Admin') {
    throw ApiError.badRequest('Select a specific outlet before creating');
  }
```

Then inside the `data: { ... }` object of `prisma.order.create`, add the `outletId` field (place it right after the `orderNumber,` line):

```ts
      orderNumber,
      outletId: scope,
```

(For a non-super-admin, `scope` is their own outlet id, or `null` for the rare unassigned user — same as today. For a Super Admin who passed a specific outlet, `scope` is that id.)

- [ ] **Step 4: Typecheck**

Run: `cd Ovenisto-backend && npm run typecheck`
Expected: exits 0. (`ApiError` is already imported in this file; `req.user` is already typed.)

- [ ] **Step 5: Manual live verification**

Start the backend (`npm run dev`) and verify with curl (replace TOKEN with a Super Admin login token):

```bash
# Super Admin on "All" creating an order → 400 with the exact message
curl -s -o /dev/null -w "%{http_code}\n" -X POST http://localhost:3001/api/orders \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -H "X-Outlet-Id: all" \
  -d '{"type":"Dine In","total":100,"items":[{"name":"Test","price":100,"qty":1}]}'
# Expected: 400
```

Expected: `400`. Then repeat with `-H "X-Outlet-Id: <a-real-outlet-id>"` → expect `201`, and confirm the created order has that `outletId` (GET `/api/orders` with the same header returns it).

- [ ] **Step 6: Commit**

```bash
cd Ovenisto-backend
git add src/modules/order/order.controller.ts
git commit -m "Scope orders by outlet: filter list, stamp + guard on create"
```

---

## Task 3: Apply scope to Warehouses, Reports, and Dashboard reads

**Files:**
- Modify: `src/modules/warehouse/warehouse.controller.ts` (`getWarehouses` ~line 30-51)
- Modify: `src/modules/reports/reports.controller.ts` (`getParams` ~line 16-22; `getDashboard` ~line 212-219)

**Interfaces:**
- Consumes: `resolveOutletScope(req): string | null` from Task 1.
- Produces: warehouse list + all report/dashboard queries enforced by scope (non-super-admins pinned to their own outlet even if they pass a different `outletId`).

- [ ] **Step 1: Warehouses — import + filter**

At the top of `src/modules/warehouse/warehouse.controller.ts`, add:

```ts
import { resolveOutletScope } from '../../middleware/outletScope.js';
```

In `getWarehouses`, the current code reads `outletId` from the query and does `if (outletId) where.outletId = String(outletId);` (around line 35). REPLACE that single line with the scope-resolved version so a non-super-admin can't pass a foreign outlet. Find:

```ts
  if (outletId) where.outletId = String(outletId);
```

Replace with:

```ts
  const scope = resolveOutletScope(req);
  if (scope) where.outletId = scope;
```

(If the handler still destructures `outletId` from `req.query` and it is now unused, remove it from the destructure to keep typecheck clean.)

- [ ] **Step 2: Reports — route `getParams` through the helper**

At the top of `src/modules/reports/reports.controller.ts`, add:

```ts
import { resolveOutletScope } from '../../middleware/outletScope.js';
```

The current `getParams` (around line 16-22) reads:

```ts
  const from = req.query.from as string | undefined;
  const to = req.query.to as string | undefined;
  const outletId = req.query.outletId as string | undefined;
  // ...
  return { gte, lte, outletId };
```

Change the `outletId` line so the value is enforced, not trusted. Replace:

```ts
  const outletId = req.query.outletId as string | undefined;
```

with:

```ts
  // Enforce outlet scope: non-super-admins are pinned to their own outlet.
  // resolveOutletScope returns null for "All" (Super Admin) → undefined keeps the
  // existing "no outlet filter" behavior downstream.
  const outletId = resolveOutletScope(req) ?? undefined;
```

(Downstream `buildOrderWhere(gte, lte, outletId)` and the `expensesAreRestaurantWide = !!outletId && outletId !== 'all'` checks already treat a falsy `outletId` as "no filter", so passing `undefined` for the All case is correct.)

- [ ] **Step 3: Dashboard — route its own outletId read through the helper**

`getDashboard` reads `outletId` separately (around line 213):

```ts
  const outletId = req.query.outletId as string | undefined;
```

Replace with:

```ts
  const outletId = resolveOutletScope(req) ?? undefined;
```

The existing `const outletFilter = outletId && outletId !== 'all' ? { outletId } : {};` line stays as-is and works correctly (falsy → no filter).

- [ ] **Step 4: Typecheck**

Run: `cd Ovenisto-backend && npm run typecheck`
Expected: exits 0. (Remove any now-unused `outletId`/`req.query` destructures the compiler flags.)

- [ ] **Step 5: Manual live verification**

With the backend running and a Super Admin token:

```bash
# Dashboard for a specific outlet vs all — totals should differ (or match if all data is one outlet)
curl -s http://localhost:3001/api/reports/dashboard -H "Authorization: Bearer $TOKEN" -H "X-Outlet-Id: all" | head -c 120; echo
curl -s http://localhost:3001/api/reports/dashboard -H "Authorization: Bearer $TOKEN" -H "X-Outlet-Id: <real-outlet-id>" | head -c 120; echo
```

Expected: both return `success: true`; the specific-outlet response reflects only that outlet's orders. (With a non-super-admin token, passing a foreign `X-Outlet-Id` must still return only their own outlet's numbers.)

- [ ] **Step 6: Commit**

```bash
cd Ovenisto-backend
git add src/modules/warehouse/warehouse.controller.ts src/modules/reports/reports.controller.ts
git commit -m "Enforce outlet scope on warehouses, reports, and dashboard reads"
```

---

## Task 4: Frontend `outletStore` + `api.ts` request plumbing

**Files:**
- Create: `src/services/outletStore.ts`
- Test: `src/services/__tests__/outletStore.test.ts`
- Modify: `src/services/api.ts` (`request` ~line 47-85; `getCacheKey` ~line 161-163; `invalidateCache` ~line 171-178)

**Interfaces:**
- Produces: `outletStore.get(): string`, `outletStore.set(id: string): void` (default `'all'`).
- Effect: every `api.*` call sends `X-Outlet-Id: <active outlet>`; the GET cache is keyed per outlet; invalidation still works across the new key format.

- [ ] **Step 1: Write the failing test for the store**

Create `src/services/__tests__/outletStore.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { outletStore } from '../outletStore';

describe('outletStore', () => {
  beforeEach(() => outletStore.set('all'));

  it('defaults to "all"', () => {
    expect(outletStore.get()).toBe('all');
  });

  it('set then get returns the new value', () => {
    outletStore.set('o1');
    expect(outletStore.get()).toBe('o1');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd Ovenisto_Frontend_Software && npx vitest run src/services/__tests__/outletStore.test.ts`
Expected: FAIL — cannot find module `../outletStore`.

- [ ] **Step 3: Write the store**

Create `src/services/outletStore.ts`:

```ts
/**
 * Module-level holder for the currently active outlet id ("all" or an id).
 * OutletContext keeps this in sync; api.ts reads it on every request so the
 * active outlet is attached without threading it through every service call.
 */
let activeOutletId = 'all';

export const outletStore = {
  get: (): string => activeOutletId,
  set: (id: string): void => { activeOutletId = id || 'all'; },
};
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd Ovenisto_Frontend_Software && npx vitest run src/services/__tests__/outletStore.test.ts`
Expected: PASS — 2 passed.

- [ ] **Step 5: Inject the header in `api.ts`**

In `src/services/api.ts`, add the import at the top (after the file's opening comment / `API_BASE`):

```ts
import { outletStore } from './outletStore';
```

In the `request` function there are TWO `fetch` calls (the initial request ~line 53 and the post-refresh retry ~line 68), each with a `headers` object containing `'Content-Type'`, optional `Authorization`, and `...options.headers`. Add the outlet header to BOTH, right after `'Content-Type': 'application/json',`:

```ts
      'Content-Type': 'application/json',
      'X-Outlet-Id': outletStore.get(),
```

(Apply the identical addition to the retry fetch's headers block.)

- [ ] **Step 6: Fold the outlet into the cache key**

Find `getCacheKey` (~line 161):

```ts
function getCacheKey(endpoint: string): string {
  return endpoint;
}
```

Replace with:

```ts
function getCacheKey(endpoint: string): string {
  // Per-outlet cache: switching outlets must not serve another outlet's rows.
  return `${outletStore.get()}::${endpoint}`;
}
```

- [ ] **Step 7: Fix `invalidateCache` for the new key format**

`invalidateCache` (~line 171) matches keys with `key.startsWith(base)`, where `base` is a path like `/orders`. With keys now prefixed `outlet::`, that match never hits. Replace the function body so it matches the path part after the `::` prefix (invalidating that base path across all outlets, which is correct):

```ts
function invalidateCache(endpoint: string): void {
  const base = getBasePath(endpoint);
  const keysToDelete: string[] = [];
  cache.forEach((_, key) => {
    const sep = key.indexOf('::');
    const path = sep >= 0 ? key.slice(sep + 2) : key;
    if (path.startsWith(base)) keysToDelete.push(key);
  });
  keysToDelete.forEach(k => cache.delete(k));
}
```

- [ ] **Step 8: Typecheck, build, run the store test**

Run: `cd Ovenisto_Frontend_Software && npx tsc --noEmit && npm run build && npx vitest run src/services/__tests__/outletStore.test.ts`
Expected: tsc exits 0; build succeeds; 2 tests pass.

- [ ] **Step 9: Commit**

```bash
cd Ovenisto_Frontend_Software
git add src/services/outletStore.ts src/services/__tests__/outletStore.test.ts src/services/api.ts
git commit -m "Send X-Outlet-Id header on every request and key the GET cache per outlet"
```

---

## Task 5: Frontend `OutletContext` + provider wiring

**Files:**
- Create: `src/contexts/OutletContext.tsx`
- Modify: `src/App.tsx` (wrap with `OutletProvider`)
- Modify: `src/contexts/AuthContext.tsx` (clear stored outlet on logout)

**Interfaces:**
- Consumes: `outletStore` (Task 4); `useAuth()` for the current user (`{ role, outletId }`); `outletService.getOutlets()` (existing) for the outlet list.
- Produces: `useOutlet(): { selectedOutletId, setSelectedOutletId, outlets, isLocked }`; `<OutletProvider>`.

- [ ] **Step 1: Confirm the auth + outlet service shapes**

Read `src/contexts/AuthContext.tsx` to confirm `useAuth()` returns a `user` with `role: string` and `outletId?: string | null`, and to find the logout function. Read `src/services/outlet.service.ts` to confirm `outletService.getOutlets()` returns `{ id: string; name: string }[]` (or an object with `.data`). Use the real shapes in the code below — if `getOutlets()` returns `{ data }`, adjust the `.then` accordingly.

- [ ] **Step 2: Write the context**

Create `src/contexts/OutletContext.tsx`:

```tsx
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { useAuth } from "./AuthContext";
import { outletService } from "@/services/outlet.service";
import { outletStore } from "@/services/outletStore";

const STORAGE_KEY = "ovenisto_selected_outlet";

interface OutletOption { id: string; name: string; }

interface OutletContextValue {
  selectedOutletId: string;
  setSelectedOutletId: (id: string) => void;
  outlets: OutletOption[];
  isLocked: boolean;
}

const OutletContext = createContext<OutletContextValue | undefined>(undefined);

export function OutletProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const isSuperAdmin = user?.role === "Super Admin";
  const isLocked = !isSuperAdmin;

  const { data: outlets = [] } = useQuery({
    queryKey: ["outlets"],
    queryFn: () => outletService.getOutlets(),
    enabled: !!user,
  });

  // Initialize: Super Admin → last saved or "all"; everyone else → their own outlet.
  const [selectedOutletId, setSelected] = useState<string>(() => {
    if (!user) return "all";
    if (isSuperAdmin) return localStorage.getItem(STORAGE_KEY) || "all";
    return user.outletId || "all";
  });

  // Re-initialize when the user changes (login/logout/role switch).
  useEffect(() => {
    let next: string;
    if (!user) next = "all";
    else if (isSuperAdmin) next = localStorage.getItem(STORAGE_KEY) || "all";
    else next = user.outletId || "all";
    setSelected(next);
    outletStore.set(next);
  }, [user, isSuperAdmin]);

  // Keep the request-layer holder in sync on every change.
  useEffect(() => {
    outletStore.set(selectedOutletId);
  }, [selectedOutletId]);

  const setSelectedOutletId = (id: string) => {
    if (isLocked) return; // non-super-admins cannot change their outlet
    setSelected(id);
    localStorage.setItem(STORAGE_KEY, id);
    outletStore.set(id);
  };

  return (
    <OutletContext.Provider value={{ selectedOutletId, setSelectedOutletId, outlets, isLocked }}>
      {children}
    </OutletContext.Provider>
  );
}

export function useOutlet(): OutletContextValue {
  const ctx = useContext(OutletContext);
  if (!ctx) throw new Error("useOutlet must be used within an OutletProvider");
  return ctx;
}
```

> If `outletService.getOutlets()` resolves to `{ data: OutletOption[] }`, change the `queryFn` to `() => outletService.getOutlets().then(r => r.data)`.

- [ ] **Step 3: Wrap the app**

In `src/App.tsx`, import the provider:

```tsx
import { OutletProvider } from "@/contexts/OutletContext";
```

Place `<OutletProvider>` INSIDE the existing `AuthProvider` (it depends on `useAuth`) and OUTSIDE the routed pages, and ensure it is within the `QueryClientProvider` (it uses `useQuery`). Concretely, wrap whatever currently renders the routes/layout, e.g.:

```tsx
<AuthProvider>
  <OutletProvider>
    {/* existing children: router / routes / layout */}
  </OutletProvider>
</AuthProvider>
```

Match the existing provider nesting in `App.tsx` — the only requirement is `QueryClientProvider` → `AuthProvider` → `OutletProvider` → routes.

- [ ] **Step 4: Clear the stored outlet on logout**

In `src/contexts/AuthContext.tsx`, find the logout function (it already removes `ovenisto_user` / tokens). Add this line alongside that cleanup:

```ts
    localStorage.removeItem("ovenisto_selected_outlet");
```

- [ ] **Step 5: Typecheck + build**

Run: `cd Ovenisto_Frontend_Software && npx tsc --noEmit && npm run build`
Expected: tsc exits 0; build succeeds.

- [ ] **Step 6: Commit**

```bash
cd Ovenisto_Frontend_Software
git add src/contexts/OutletContext.tsx src/App.tsx src/contexts/AuthContext.tsx
git commit -m "Add OutletContext: role-based active outlet, persisted and synced to request layer"
```

---

## Task 6: Frontend header outlet selector

**Files:**
- Modify: `src/components/layout/AppHeader.tsx`

**Interfaces:**
- Consumes: `useOutlet()` from Task 5; shadcn `Select`.
- Produces: a header dropdown — Super Admin sees "All Outlets" + every outlet (enabled); everyone else sees their outlet (disabled).

- [ ] **Step 1: Read the header to find the placement**

Read `src/components/layout/AppHeader.tsx` and identify the right-side actions area (where the user menu / notifications live) so the selector sits there. Confirm whether shadcn `Select` is already imported elsewhere in the file; if not, add the import.

- [ ] **Step 2: Add the selector**

Add the import (if not already present):

```tsx
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useOutlet } from "@/contexts/OutletContext";
```

Inside the `AppHeader` component body, read the context:

```tsx
  const { selectedOutletId, setSelectedOutletId, outlets, isLocked } = useOutlet();
```

In the header's right-side actions area, render the dropdown (place it before the user menu):

```tsx
        <Select
          value={selectedOutletId}
          onValueChange={setSelectedOutletId}
          disabled={isLocked}
        >
          <SelectTrigger className="w-[160px] h-9 text-sm">
            <SelectValue placeholder="Outlet" />
          </SelectTrigger>
          <SelectContent>
            {!isLocked && <SelectItem value="all">All Outlets</SelectItem>}
            {outlets.map((o) => (
              <SelectItem key={o.id} value={o.id}>{o.name}</SelectItem>
            ))}
          </SelectContent>
        </Select>
```

> For a locked (non-super-admin) user, `selectedOutletId` is their own outlet id; the list contains their outlet, so the trigger shows its name and the control is disabled. If the locked user's outlet somehow isn't in the loaded list yet, the trigger shows the placeholder until outlets load — acceptable.

- [ ] **Step 3: Typecheck + build**

Run: `cd Ovenisto_Frontend_Software && npx tsc --noEmit && npm run build`
Expected: tsc exits 0; build succeeds.

- [ ] **Step 4: Manual browser verification (Super Admin)**

Run the frontend (`npm run dev`) against the local backend. Log in as Super Admin:
- The header shows an outlet dropdown with "All Outlets" + each outlet, enabled.
- Switch from "All Outlets" to a specific outlet → the Dashboard and Orders data change to that outlet (react-query refetches; the `api.ts` cache is per-outlet).
- Refresh the page → the previously selected outlet is still selected (localStorage).

- [ ] **Step 5: Manual browser verification (non-super-admin)**

Log in as a Manager/Cashier linked to one outlet:
- The header dropdown shows that outlet's name and is **disabled**.
- The user sees only their own outlet's data, even though no selection is possible.

- [ ] **Step 6: Commit**

```bash
cd Ovenisto_Frontend_Software
git add src/components/layout/AppHeader.tsx
git commit -m "Add header outlet selector (Super Admin switches; others locked)"
```

---

## Final Verification (after all tasks)

- [ ] Backend: `cd Ovenisto-backend && npm run test && npm run typecheck` → all pass, tsc 0.
- [ ] Frontend: `cd Ovenisto_Frontend_Software && npx tsc --noEmit && npm run build` → tsc 0, build succeeds.
- [ ] End-to-end (local): Super Admin switching outlets changes Orders + Dashboard; create-on-"All" returns the exact 400 message; a non-super-admin is locked to their outlet and a forged `X-Outlet-Id` is ignored server-side.
- [ ] Whole-branch review (subagent-driven-development's final reviewer, most capable model).
- [ ] Commits remain LOCAL — push only on explicit user instruction.

## Notes for Phase B/C

`resolveOutletScope` (backend) and `outletStore` + `OutletContext` + the `api.ts` header plumbing (frontend) are the reusable foundation. Phase B adds an `outletId` column to the transactional models (Customer, Expense, Stock*, Production, Waste, Shift, etc.), backfills, and applies the same helper to their list/create endpoints — no new plumbing required.
