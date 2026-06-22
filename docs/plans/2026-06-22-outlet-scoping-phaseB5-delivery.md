# Phase B5 — Outlet Scoping: Delivery — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Outlet-scope the Delivery module (DeliveryRider + DeliveryAssignment) so non-admin users see/act only on their own outlet's riders and assignments, deriving outlet from `user.outletId` (riders) and `order.outletId` (assignments).

**Architecture:** Pure controller changes in one file — no schema, no backfill (both entities derive outlet from relations). Rider handlers filter/guard via the linked User's `outletId`; assignment handlers filter/guard via the Order's `outletId` (already scoped since Phase A). Each by-id handler guards before any mutation; each list/aggregate adds a relation filter when scoped.

**Tech Stack:** Express + TypeScript + Prisma. Existing helper `resolveOutletScope` from `src/middleware/outletScope.ts`.

## Global Constraints

- **Scoping rule:** `scope = resolveOutletScope(req)`. When `scope === null` (Super Admin on "All", admins, central staff) apply **no** filter. Riders are in scope iff `rider.user.outletId === scope`; assignments iff `assignment.order.outletId === scope`.
- **`resolveOutletScope(req)`** returns: Super Admin → `X-Outlet-Id` header / `?outletId=`, or `null` for `'all'`/absent; every other role → `req.user?.outletId ?? null`.
- **No schema change, no backfill, no frontend change.**
- **ApiError style in this file is STATIC:** `ApiError.notFound('msg')`, `ApiError.badRequest('msg')`. Do NOT use the `new ApiError('msg', code)` constructor form here.
- **By-id cross-outlet response:** `ApiError.notFound('Rider not found')` / `ApiError.notFound('Assignment not found')` — never leak existence; the guard runs **before** any `$transaction`.
- **Cross-outlet create/assign response:** `ApiError.badRequest(...)` / `ApiError.notFound(...)` with a specific message.
- **Do NOT change** `getMyAssignments` or `getMyStats` — they are the rider's own data (keyed by `riderId`) and are correctly not outlet-scoped. Do NOT change the assignment status machine, cash-collection, or rider-availability logic.
- **No test runner exists for the backend** (vitest is frontend-only). Verification = `npm run typecheck` (no errors) + `npm run build` (exit 0). Do NOT create backend `.test.ts` files.
- All commits are **local only** until the human says "push".

---

### Task 1: Outlet-scope the Delivery controller

**Files:**
- Modify: `src/modules/delivery/delivery.controller.ts`

**Interfaces:**
- Consumes: `resolveOutletScope(req: Request): string | null` from `../../middleware/outletScope.js`.
- Produces: nothing new exported; behavior change only.

**Context:** Single file. Riders are `role=RIDER` Users — `getRiders` is built from `prisma.user.findMany`, and each rider's outlet is its linked `User.outletId`. Assignments belong to an `Order` which already carries `outletId`. Line numbers below refer to the file's CURRENT state; after the first edit they shift — locate each target by its surrounding code, not absolute line number.

- [ ] **Step 1: Add the import**

After the `asyncHandler` import (line 8), add:

```ts
import { resolveOutletScope } from '../../middleware/outletScope.js';
```

- [ ] **Step 2: Scope `getRiders` (filter the user query by outletId)**

Replace the handler signature + user query (currently lines 32-38):

```ts
export const getRiders = asyncHandler(async (_req: Request, res: Response) => {
  // Pull users with Rider role and join their DeliveryRider profile
  const riderUsers = await prisma.user.findMany({
    where: { role: 'RIDER' as any, status: 'active' },
    include: { riderProfile: true },
    orderBy: { name: 'asc' },
  });
```

with:

```ts
export const getRiders = asyncHandler(async (req: Request, res: Response) => {
  // Pull users with Rider role and join their DeliveryRider profile
  const scope = resolveOutletScope(req);
  const riderUsers = await prisma.user.findMany({
    where: { role: 'RIDER' as any, status: 'active', ...(scope ? { outletId: scope } : {}) },
    include: { riderProfile: true },
    orderBy: { name: 'asc' },
  });
```

- [ ] **Step 3: Scope `createRider` (a scoped user may only link a same-outlet user)**

In `createRider`, replace the `userId` validation block (currently lines 61-66):

```ts
  if (userId) {
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw ApiError.notFound('User not found');
    const existing = await prisma.deliveryRider.findUnique({ where: { userId } });
    if (existing) throw ApiError.badRequest('This user already has a rider profile');
  }
```

with:

```ts
  if (userId) {
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw ApiError.notFound('User not found');
    const scope = resolveOutletScope(req);
    if (scope && user.outletId !== scope) throw ApiError.badRequest('Rider user is not in your outlet');
    const existing = await prisma.deliveryRider.findUnique({ where: { userId } });
    if (existing) throw ApiError.badRequest('This user already has a rider profile');
  }
```

- [ ] **Step 4: Guard `updateRider` by-id (via the rider's linked user outlet)**

In `updateRider`, replace the load + not-found (currently lines 76-77):

```ts
  const rider = await prisma.deliveryRider.findUnique({ where: { id } });
  if (!rider) throw ApiError.notFound('Rider not found');
```

with:

```ts
  const rider = await prisma.deliveryRider.findUnique({ where: { id }, include: { user: { select: { outletId: true } } } });
  if (!rider) throw ApiError.notFound('Rider not found');
  const scope = resolveOutletScope(req);
  if (scope && rider.user?.outletId !== scope) throw ApiError.notFound('Rider not found');
```

- [ ] **Step 5: Scope `getAssignments` (filter by order outlet)**

In `getAssignments`, after the `where` is built from the query filters and before the `findMany` (currently after line 104, before line 106), add:

```ts
  const scope = resolveOutletScope(req);
  if (scope) where.order = { outletId: scope };
```

so the block reads:

```ts
  if (date) {
    const start = new Date(date); start.setHours(0, 0, 0, 0);
    const end   = new Date(date); end.setHours(23, 59, 59, 999);
    where.assignedAt = { gte: start, lte: end };
  }

  const scope = resolveOutletScope(req);
  if (scope) where.order = { outletId: scope };

  const assignments = await prisma.deliveryAssignment.findMany({
```

- [ ] **Step 6: Guard `assignRider` (order outlet + rider outlet) before the transaction**

In `assignRider`, replace the load + checks (currently lines 166-172):

```ts
  const [order, rider] = await Promise.all([
    prisma.order.findUnique({ where: { id: orderId } }),
    prisma.deliveryRider.findUnique({ where: { id: riderId } }),
  ]);
  if (!order)  throw ApiError.notFound('Order not found');
  if (!rider)  throw ApiError.notFound('Rider not found');
  if (!rider.isAvailable) throw ApiError.badRequest('Rider is not available');
```

with:

```ts
  const [order, rider] = await Promise.all([
    prisma.order.findUnique({ where: { id: orderId } }),
    prisma.deliveryRider.findUnique({ where: { id: riderId }, include: { user: { select: { outletId: true } } } }),
  ]);
  if (!order)  throw ApiError.notFound('Order not found');
  if (!rider)  throw ApiError.notFound('Rider not found');
  const scope = resolveOutletScope(req);
  if (scope && order.outletId !== scope) throw ApiError.notFound('Order not found');
  if (scope && rider.user?.outletId !== scope) throw ApiError.badRequest('Rider is not in your outlet');
  if (!rider.isAvailable) throw ApiError.badRequest('Rider is not available');
```

- [ ] **Step 7: Guard `updateAssignmentStatus` by-id (via order outlet) before the transaction**

In `updateAssignmentStatus`, replace the load + not-found (currently lines 208-209):

```ts
  const assignment = await prisma.deliveryAssignment.findUnique({ where: { id }, include: { rider: true } });
  if (!assignment) throw ApiError.notFound('Assignment not found');
```

with:

```ts
  const assignment = await prisma.deliveryAssignment.findUnique({ where: { id }, include: { rider: true, order: { select: { outletId: true } } } });
  if (!assignment) throw ApiError.notFound('Assignment not found');
  const scope = resolveOutletScope(req);
  if (scope && assignment.order?.outletId !== scope) throw ApiError.notFound('Assignment not found');
```

- [ ] **Step 8: Guard `collectAmount` by-id (via order outlet)**

In `collectAmount`, replace the load + not-found (currently lines 243-244):

```ts
  const assignment = await prisma.deliveryAssignment.findUnique({ where: { id } });
  if (!assignment) throw ApiError.notFound('Assignment not found');
```

with:

```ts
  const assignment = await prisma.deliveryAssignment.findUnique({ where: { id }, include: { order: { select: { outletId: true } } } });
  if (!assignment) throw ApiError.notFound('Assignment not found');
  const scope = resolveOutletScope(req);
  if (scope && assignment.order?.outletId !== scope) throw ApiError.notFound('Assignment not found');
```

- [ ] **Step 9: Guard `getRiderStats` by-id (via the rider's linked user outlet)**

In `getRiderStats`, replace the load + not-found (currently lines 261-262):

```ts
  const rider = await prisma.deliveryRider.findUnique({ where: { id } });
  if (!rider) throw ApiError.notFound('Rider not found');
```

with:

```ts
  const rider = await prisma.deliveryRider.findUnique({ where: { id }, include: { user: { select: { outletId: true } } } });
  if (!rider) throw ApiError.notFound('Rider not found');
  const scope = resolveOutletScope(req);
  if (scope && rider.user?.outletId !== scope) throw ApiError.notFound('Rider not found');
```

- [ ] **Step 10: Scope `getDeliveryDashboard` (riders by user outlet, deliveries/active by order outlet)**

In `getDeliveryDashboard`, replace the signature + the `Promise.all` block (currently lines 287-302):

```ts
export const getDeliveryDashboard = asyncHandler(async (_req: Request, res: Response) => {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const todayEnd = new Date(today); todayEnd.setHours(23, 59, 59, 999);

  const [riders, todayDeliveries, activeAssignments] = await Promise.all([
    prisma.deliveryRider.findMany({ orderBy: { name: 'asc' } }),
    prisma.deliveryAssignment.findMany({
      where: { status: 'delivered', deliveredAt: { gte: today, lte: todayEnd } },
      include: { order: { select: { total: true } } },
    }),
    prisma.deliveryAssignment.findMany({
      where: { status: { in: ['pending', 'accepted', 'dispatched'] } },
      include: { order: { select: { id: true, orderNumber: true, total: true, customer: true, deliveryAddress: true } }, rider: true },
      orderBy: { assignedAt: 'desc' },
    }),
  ]);
```

with:

```ts
export const getDeliveryDashboard = asyncHandler(async (req: Request, res: Response) => {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const todayEnd = new Date(today); todayEnd.setHours(23, 59, 59, 999);

  const scope = resolveOutletScope(req);
  const [riders, todayDeliveries, activeAssignments] = await Promise.all([
    prisma.deliveryRider.findMany({ where: scope ? { user: { outletId: scope } } : {}, orderBy: { name: 'asc' } }),
    prisma.deliveryAssignment.findMany({
      where: { status: 'delivered', deliveredAt: { gte: today, lte: todayEnd }, ...(scope ? { order: { outletId: scope } } : {}) },
      include: { order: { select: { total: true } } },
    }),
    prisma.deliveryAssignment.findMany({
      where: { status: { in: ['pending', 'accepted', 'dispatched'] }, ...(scope ? { order: { outletId: scope } } : {}) },
      include: { order: { select: { id: true, orderNumber: true, total: true, customer: true, deliveryAddress: true } }, rider: true },
      orderBy: { assignedAt: 'desc' },
    }),
  ]);
```

- [ ] **Step 11: Typecheck**

Run: `npm run typecheck`
Expected: completes with no errors.

- [ ] **Step 12: Build**

Run: `npm run build`
Expected: `prisma generate` then `tsc` complete with exit code 0.

- [ ] **Step 13: Commit**

```bash
git add src/modules/delivery/delivery.controller.ts
git commit -m "feat(delivery): outlet-scope riders + assignments via resolveOutletScope (B5)"
```

---

## Post-Implementation (after the task is merged — done by the human/controller, not a task)

- **Deploy:** push `main` → Railway auto-deploy (if it stalls, replicate `npm run build` locally then push an empty commit to re-trigger — see B4a/B4b notes; when scripting a live probe, refresh the JWT in a retry loop and assert it's non-empty or a cold-DB login failure yields false 401s).
- **No backfill** to run (B5 adds no column).
- **Live verification** (spec §6): rider/assignment list totals differ across `X-Outlet-Id: all` vs Main vs DHA; cross-outlet by-id rider stats & assignment status/collect → 404; cross-outlet assign → 404/400; dashboard riderStats + activeAssignments differ per outlet; rider portal `my-assignments` / `my-stats` still return the rider's own data.

## Self-Review Notes (author)

- **Spec coverage:** §3 riders-via-user → Steps 2,3,4,9; assignments-via-order → Steps 5,6,7,8; dashboard → Step 10; getMyAssignments/getMyStats left unchanged per §2. §4 every listed handler has a step. §5 error codes → Global Constraints + each step. §6 verification → Post-Implementation. All covered.
- **Type consistency:** `resolveOutletScope` import path identical to other modules; rider guard uses `rider.user?.outletId`, assignment guard uses `assignment.order?.outletId`; all guards use the STATIC `ApiError.notFound/badRequest` to match this file.
- **No placeholders:** every code step shows exact before/after.
