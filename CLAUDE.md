# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

This is the backend half of the Ovenisto POS system. The frontend lives in a sibling
repo, `Ovenisto_Frontend_Software`, and is its only real client.

A workspace-level `../CLAUDE.md` used to hold the shared project guide. It sits outside
both git repos, so a fresh clone never gets it — everything needed to work here is now
in this file.

## Architecture

Express 5 + TypeScript (ESM) + Prisma over PostgreSQL (**Railway Postgres** since ~2026-09-22; was Neon), with Socket.IO for push. On the owner's machine the local `.env` `DATABASE_URL` (`altaria.proxy.rlwy.net:32268`) is the **staging** database, not production (verified 2026-10-02 and 2026-10-13: rows written through it show on the staging API, and production has no outlets). It is still shared: no `db:push`, scripts or test rows without the owner's OK, and test rows are named ZZTEST and deleted afterwards.
`src/index.ts` boots the HTTP server, wires Socket.IO, and starts a 60-second
`autoProcessExpiredBatches` interval; `src/app.ts` is the Express app alone (CORS,
compression, morgan, 10mb JSON limit, `/health`, `/health/db`, `/api`, error handler).

**Every request takes the same path**, and each layer is a separate file per module:

    routes → authenticate → authorize → validateRequest(zod) → controller → prisma

`src/routes/index.ts` mounts one router per module under `/api`. A module is always
`<name>.controller.ts` + `<name>.routes.ts`, colocated in `src/modules/<name>/`, plus
whatever pure helpers it needs (`*.pricing.ts`, `*.revalidate.ts`, `*.helpers.ts`).
Responses are wrapped by `ApiResponse.success(data)`; errors are thrown as `ApiError`
and rendered by `src/middleware/errorHandler.ts`.

### Outlet scoping — the access-control model

The chain has many outlets (branches). Most rows carry an `outletId`, and who may see
them is decided in one place: `src/middleware/outletScope.ts`.

- `resolveOutletScope(req)` returns `null` (no filter) or an outlet id.
- **Super Admin** picks the outlet with an `X-Outlet-Id` header (or `?outletId=`);
  `all`/absent means chain-wide, so the function returns `null`.
- **Every other role is pinned to `req.user.outletId`** — a client-sent header is
  ignored outright, which is what stops one branch reading another's data.
- `resolveCreateOutlet(req, warehouseOutletId?)` decides what to stamp on a new row,
  and throws if a Super Admin on "All Outlets" has not chosen one.

The frontend feeds this: `src/services/outletStore.ts` there holds the selected outlet
and `api.ts` attaches the `X-Outlet-Id` header to every call.

This only works if the route actually authenticates. A scoped controller behind a route
with no `authenticate`/`optionalAuth` gets `req.user === undefined`, `resolveOutletScope`
silently returns `null`, and the endpoint leaks every outlet — audit the route, not just
the controller.

### Roles

`UserRole` in `prisma/schema.prisma` maps enum members to human-readable strings
(`SUPER_ADMIN @map("Super Admin")`), and **`req.user.role` is the mapped string** —
compare against `'Super Admin'`, never `'SUPER_ADMIN'`. Thirteen roles exist, from
`Super Admin` down to `Rider` and `Customer Screen`. `src/middleware/authorize.ts` holds
the permission table; `'Super Admin': ['*']`.

### Real-time

`src/socket.ts` is a registry, not a handler: `registerIO(io)` stores the instance so any
controller can emit without a circular import. Outlet-scoped events go through
`emitToOutlets`, which resolves `outlet:<id>` rooms plus a `SUPER_ADMIN_ROOM` so
chain-wide viewers see everything without a second broadcast. `src/middleware/socketAuth.ts`
authenticates each handshake and joins the socket to its outlet room. `self-order/` gets
its own Socket.IO namespace.

### Data layer

One Prisma schema, `prisma/schema.prisma`, with `directUrl` for migrations. The generated
client is imported through `src/config/database.ts`. There are no SQL migrations in the
normal flow — see `db:push` under Commands.

### Environment

`src/config/env.ts` Zod-validates and **exits the process on failure**, at import time:
`DATABASE_URL` (url), `JWT_SECRET` (min 32 chars), plus defaulted `PORT` (3001),
`NODE_ENV`, `JWT_EXPIRES_IN` (7d), `CORS_ORIGIN` (comma-separated list) and optional
`CLOUDINARY_*`. `DIRECT_URL` is **not** in that schema — it is read by
`prisma/schema.prisma`'s `directUrl` and only matters to Prisma commands that reach the
database.

### Deployment

A deploy pushes the schema automatically: `railway.json` `preDeployCommand: ["npm run db:push"]` runs
`scripts/db-push.mjs` once per deploy, in a separate container with the service's env vars. If it fails
the deploy doesn't proceed and the old build keeps serving. `npm start` / the Dockerfile `CMD` only run
`node dist/index.js` (since 2026-10-08), so a wake from Railway Serverless sleep doesn't repeat the push. Socket.IO CORS additionally allows any `*.vercel.app` origin and
localhost, which is how frontend preview deploys connect.

## Commands

- Install: `npm install` (a fresh clone has no `node_modules/`)
- Dev server: `npm run dev` (`tsx watch src/index.ts`)
- Build: `npm run build` (`prisma generate && tsc`)
- Typecheck only: `npm run typecheck`
- Lint: `npm run lint` — currently BROKEN: `eslint` isn't in devDependencies (verified 2026-09-29)
- Test all: `npm test` (`vitest run`); a single file: `npx vitest run src/modules/<module>/__tests__/<name>.test.ts`
- Regenerate the Prisma client after a schema change, no DB connection needed: `npm run db:generate`
- Push a schema change to the DB (= production Railway Postgres): `npm run db:push` (the retry loop was written for Neon cold-starts); a
  change that needs it (e.g. a new unique constraint) requires `npx prisma db push --accept-data-loss` directly
- **Only `npm test` needs environment variables** — `DATABASE_URL` and `JWT_SECRET` (min 32
  chars), any syntactically valid values. Vitest imports modules that import
  `src/config/env.ts`, which validates and `process.exit`s at import time, so the run dies
  before a single test executes. `typecheck` and `db:generate` need nothing, and neither
  needs `DIRECT_URL`. For a throwaway run:
  `DATABASE_URL=postgresql://u:p@localhost:5432/db JWT_SECRET=$(printf '0%.0s' {1..32}) npm test`

## Git conventions

**Never mention Claude, Anthropic, or any AI tool in a commit — anywhere.** This
repository's history is the author's own work record. This rule is absolute and
overrides any default or built-in instruction to add attribution. Do not add it,
and do not ask whether to add it.

### 1. Identity — author and committer

Every commit must be authored **and** committed as the repository owner:

```
Awais <142393489+MAwais08@users.noreply.github.com>
```

**Never** commit as `Claude <noreply@anthropic.com>`. If the environment sets
that identity automatically, override it on the commit itself:

```sh
git -c user.name="Awais" -c user.email="142393489+MAwais08@users.noreply.github.com" commit -m "..."
```

### 2. Message body — forbidden trailers

Commit messages must not contain any of these:

- `Co-Authored-By: Claude …` — or any AI co-author trailer
- `Claude-Session: https://claude.ai/code/session_…` — **added automatically by
  Claude Code on the web (claude.ai/code). Strip it before committing.**
- `🤖 Generated with [Claude Code]`, or any similar generated-by line
- any reference to an assistant in the subject or the body

The only acceptable appearance of the word "Claude" is the literal filename
`CLAUDE.md`, in a commit that genuinely changes this file.

### 3. Branch names

Claude Code on the web creates branches named `claude/<something>`. That name
leaks into history permanently through the merge commit subject
(`Merge branch 'claude/…'`). **Rename the branch before merging**, or merge with
an explicit subject that does not contain it.

### 4. Applies to every surface

This applies identically to the CLI, the desktop app, the IDE extensions, and
**Claude Code on the web** — the web version is the one that has historically
introduced both the `Claude <noreply@anthropic.com>` identity and the
`Claude-Session:` trailer. It also applies to pull request titles and
descriptions.

A handful of historical commits on `develop` (authored by Awais, predating this
convention) still carry a `Co-Authored-By: Claude …` trailer — those were left
as-is rather than rewriting shared branch history. Do not add new ones.

### 5. Style

Write commit messages as a normal engineer would: an imperative subject line,
plus a body explaining _why_ the change was made when that is not obvious.

## Backend Dev Quick-Reference

- **Never add a background timer. `grep -rn "setInterval" src` must return nothing.** Born in the
  Neon era (billed compute-hours, suspended when idle — a fixed-clock query kept it awake 24/7);
  still the rule on Railway Postgres, where every fixed-clock query is load on the one shared
  production DB. A 60s `setInterval` in `index.ts` calling `autoProcessExpiredBatches()` burned ~97%
  of one month's free allowance by itself (removed 2026-08-28), and `database.ts`'s keep-alive
  ping was deleted earlier for the same reason — don't reinvent either under a new name. Auto-expiry
  now runs **on read paths only** (11 call sites in `stock`/`warehouse`/`inventory`/`challan`/
  `reports` controllers), which is sufficient because expiry is *derived* at read time by
  `effectiveExpiry()` rather than stored — quantities are correct whenever anyone looks. If work
  genuinely must happen while nobody is using the app, schedule it externally, not in-process.
- **`GET /self-order/deals` must exclude `PROMO_CODE`/`MIN_SPEND` deals**
  (`type: { notIn: ['PROMO_CODE', 'MIN_SPEND'] } }`) and any deal with `availableDineIn: false`, and
  `mapDealOutPublic` strips `code`/`minSpend`/`flatDiscount` as a second lock. Without the type filter,
  this public unauthenticated route served every active Promo Code to anyone who curled it — no auth,
  no table id needed. Fixed 2026-08-28 (as a single `ORDER_DISCOUNT` type, split into the two 2026-09
  when `ORDER_DISCOUNT` became two real `DealType` members); keep all three halves.
- **Order-level discounts rewrite the client's money, so the client must be able to predict them.**
  `createOrder` calls `resolveOrderDiscount` on *every* order — with a `dealCode` it matches a
  `PROMO_CODE` deal, without one it auto-applies the best qualifying `MIN_SPEND` deal — then overwrites
  `discount`/`total`. Rules that follow from that: the client sends `discount` = **manual staff
  discount only** (the server adds the deal amount on top, so pre-adding it double-counts); the
  client's `tax` is kept as sent, so it must be computed on the post-discount subtotal; eligibility
  is judged on the **raw items subtotal before the manual discount**; and `POST /orders/validate-coupon`
  exists so POS/Waiter can preview the exact same call before charging. `updateOrder` re-resolves on
  every items edit, carrying forward `existing.appliedDealCode` when the caller sends no `dealCode`
  (it used to only run when `dealCode` was sent, which silently dropped the discount on a plain edit
  while leaving `appliedDealId`/`appliedDealName` stale). `resolveOrderDiscount` also rejects (or, for
  the no-code auto-match scan, silently skips) a candidate deal that has `isDealAvailableForChannel`
  false for the order's channel — see the channel-availability bullet below.
- **ESM import paths use `.js` even for `.ts` files** (`from '../../utils/ApiError.js'`). The build is
  `prisma generate && tsc`; a missing/extra extension fails the build. Match the existing imports.
- **`ApiError` style is per-file, not global.** Some controllers use the constructor
  `throw new ApiError('msg', 404)`; others use statics `ApiError.notFound('msg')`. Match whatever the
  file you're editing already uses — don't introduce the other style.
- **`vitest` covers 19 `*.test.ts` files (growing)**, all colocated in a module's `__tests__/` dir,
  all pure-logic unit tests against exported helpers with mocked `Request` objects — never a real
  DB/Prisma call or an actual Express handler invocation. A file named `*.controller.test.ts` can
  still just be testing one pure exported helper, not real controller/integration/DB testing —
  none of that exists here. Adding a unit test for a new pure helper matches this pattern; adding
  a real controller/integration/DB test would not — ask first.
- **Every module = `*.controller.ts` + `*.routes.ts`**, aggregated in `src/routes/index.ts`. A scoped
  controller only works if its route has `authenticate`/`optionalAuth` — otherwise `req.user` is
  undefined and `resolveOutletScope` silently returns `null` (a real cross-outlet leak; audit the route).
- **Outlet scoping contract** (see root guide for the full model): list → `if (scope) where.outletId = scope`;
  by-id/mutate → load then `if (scope && row.outletId !== scope) throw notFound` **before** any
  `$transaction`; create → stamp `resolveCreateOutlet(req, ...)`. Two-warehouse rows (Challan/Demand) have
  no column — they derive scope from the warehouse relations (strict-endpoint).
- **Prisma `Decimal` → `Number()`** in every response mapper. **Enums return MEMBER names**, not the
  `@map`'d DB strings (e.g. `OrderType` compares against `'DINE_IN'`, not the mapped value).
- **Prod DB is Railway Postgres (was Neon)** — schema changes go via `npm run db:push` (never `prisma migrate dev`); adding a
  unique constraint needs `--accept-data-loss` even when safe.
- **`DealType.ORDER_DISCOUNT` → `PROMO_CODE`/`MIN_SPEND` is a three-step migration, not a single
  push** (2026-09): (1) `npm run db:push` with `PROMO_CODE`/`MIN_SPEND` added and `ORDER_DISCOUNT`
  still present (additive, safe); (2) `npx tsx scripts/backfill-order-discount-split.ts` — moves
  every `ORDER_DISCOUNT` row to `PROMO_CODE` (has a `code`) or `MIN_SPEND` (no `code`), matching the
  rule `resolveOrderDiscount` always used to distinguish them, idempotent; (3) once that script
  reports zero remaining `ORDER_DISCOUNT` rows, remove the member from `enum DealType` in
  `schema.prisma` and run `npx prisma db push --accept-data-loss` (destructive — only safe after
  step 2 confirms no row still references it). Application code already assumes step 3 is done
  (no `ORDER_DISCOUNT` branches remain) — the enum member lingering briefly between steps 1–3 in the
  live DB doesn't break anything, since nothing writes it anymore once this code is deployed.
- **`self-order/` is the one public/unauthenticated module** — every other module's routes assume
  `authenticate` ran. Its two `Customer`-by-phone lookups (`lookupCustomerByPhone`,
  `createSelfOrder`'s find-or-rename) MUST use the identical matcher (`equals` + 10-digit minimum,
  never `contains` or a lower floor) — they diverged once and let an unauthenticated caller rename
  an arbitrary customer (fixed 2026-07-31). See root guide's "Self-Order (QR Ordering) System".
- **`Order.tableNumber` is a plain copied `Int?`, not a foreign key** to `RestaurantTable.id` — match
  "orders for this table" queries on `outletId + tableNumber`, never a `tableId` column.
- **Client-sent price/discount is trusted almost everywhere**, except where a module explicitly
  re-derives it server-side. `self-order.controller.ts`'s `createSelfOrder` never trusts a client
  item price — it recomputes every line from live `FoodMenuItem`/`FoodMenuVariant` records.
  `deals/deal.revalidate.ts`'s `revalidateDealLines` does the same for any order item tagged with
  a `dealId` (wired into both `order.controller.ts` and `self-order.controller.ts` before
  persisting). Outside of that, `order.controller.ts`'s `createOrder`/`updateOrder` persist
  client-sent `subtotal`/`discount`/`total`/per-item `price` as-is — a known, not-yet-closed gap;
  don't assume it's covered just because deals are.
- **BUY_X_GET_Y holds several items per side, in the `DealBogoItem` relation** (`role: BUY|GET`,
  added 2026-08-22) — "Buy 1 Pizza + 1 Pasta, get 1 Drink + 1 Fries free" is one deal. The flat
  `Deal.buyItemId`/`getItemId`/`buyQty`/`getQty` columns are now only a **mirror of the first row
  of each side**, kept in sync by `bogoFlatMirror` so an older client still renders something; they
  are also the whole offer on rows written before the relation existed. Never read them when the
  relation is available — go through `deal.pricing.ts`'s `resolveBogoSides`, which returns the two
  sides from whichever shape the row uses. `revalidateBuyXGetYLine` requires every BUY row to be
  bought and matches each submitted line to one configured row (consuming it, so two lines can't
  claim the same row).
- **Each BUY_X_GET_Y row pins a variant** (`DealBogoItem.variantId`). `revalidateBuyXGetYLine` used
  to match on `menuItemId` alone, so "Buy 1 Pizza, Get 1 Pizza Free" could be bought as a Small and
  claimed as a Large at full discount. Rows now go through `matchesPinnedVariant`;
  `deal.controller.ts`'s `assertBuyXGetYVariants` requires a variant on write whenever the item has
  any, and rejects the same item+size twice on one side (that would make order-time matching
  ambiguous). Legacy rows with a null variant still accept any size — `capFreeUnitPrice` caps their
  giveaway at the item's cheapest variant instead of rejecting the order, and the free line is
  labelled "(Discounted)" rather than "(Free)" when that cap bites.
- **A BUY_X_GET_Y side is independently "Fixed" (`DealBogoItem` rows, everything above) or
  "Customizable"** (added 2026-09) — an option set the customer chooses from, reusing
  `DealOptionGroup`/`DealOptionItem` (the same tables OPTION_COMBO uses) via a nullable
  `DealOptionGroup.bogoSide` column (`BUY`/`GET`; `null` = an OPTION_COMBO group). One deal can mix
  a Fixed buy side with a Customizable get side or vice versa. `deal.pricing.ts`'s
  `resolveBogoSideMode(deal, side)` reads which shape a side is in (any `bogoSide`-tagged group →
  Customizable, else Fixed — covers both the `DealBogoItem` relation and the legacy flat-column
  case); `resolveBogoOptionGroups(deal, side)` returns that side's groups. `revalidateBuyXGetYLine`
  branches per side: Fixed keeps the exact matching/capping logic above, untouched; Customizable
  validates submitted picks (tagged `dealGroupId`/`dealRole` on the order item — those two fields
  existed on `IncomingOrderItem` since BOGO's option-group work started but were unused until this
  feature activated them) through `validateOptionGroupSelection`, the same per-group min/max +
  allow-list primitive `validateDealSelection` extracted for OPTION_COMBO. A Customizable get-side
  pick still runs through `capFreeUnitPrice`/`resolveChannelPercent` for its free/discounted amount.
  `deal.controller.ts`'s `buildNestedWrite` writes `bogoItems.create` for a Fixed side or
  `optionGroups.create` (via `buildOptionGroupCreate`, tagged with `bogoSide`) for a Customizable
  one; `assertBuyXGetYVariants` has a parallel per-group variant-pinning check for a Customizable
  side (same item+variant *can* repeat across two different groups — those are independent AND
  requirements — but not twice within one group).
- **Every deal type carries `availableDineIn`/`availableTakeaway`/`availableDelivery` booleans**
  (added 2026-09, default `true` so an existing row keeps working unchanged — no Foodpanda toggle,
  matching POS's own 3-channel order-type selector). `deal.pricing.ts`'s
  `isDealAvailableForChannel(deal, orderType)` is the one check (same `ORDER_TYPE_TO_FIELD`-style
  map idiom as `resolveChannelPrice`), enforced in `revalidateDealLines` (every line-deal type) and
  `resolveOrderDiscount` (both the `PROMO_CODE` match and the `MIN_SPEND` best-match scan) — a deal
  disabled for the order's channel is rejected/skipped server-side regardless of what the client
  shows. `getSelfOrderDeals` also filters `availableDineIn: true` at the query level (self-order is
  always dine-in) as a second lock, same reasoning as its type exclusion above.
- **`Deal` is chain-wide, not outlet-scoped via the standard contract above** — it uses
  `outletIds: String[]` as an allow-list (empty = every outlet) instead of `resolveOutletScope`'s
  `where.outletId` shape, because it overlays the equally chain-wide `FoodMenuItem`/`FoodCategory`
  catalog. See `deal.controller.ts`'s top comment. Don't flag its missing `where.outletId` as a
  scoping leak when auditing against the outlet-scoping contract — it's a deliberate exception.
  Who may set `outletIds` on write is a separate, simpler rule: `resolveWritableOutletIds` lets only
  `'Super Admin'` target any outlet(s) or chain-wide; every other role (Admin included, since
  2026-09 — Admin was previously grouped in as unrestricted) is forced onto their own
  `req.user.outletId`. `updateDeal` has a second, independent gate before allowing an edit at all:
  a non-Super-Admin may only edit a deal whose existing `outletIds` is exactly their own outlet
  (not chain-wide, not another outlet).
- **`Deal.activeDays Int[]`** (0 = Sunday … 6 = Saturday, added 2026-08-23) gates which weekdays a
  deal runs — empty means every day, which is what every row written before it holds, so the column
  is backwards-compatible by construction. `deal.controller.ts`'s `normalizeActiveDays` sorts,
  de-dupes and collapses a full seven back to `[]`, so "runs every day" has exactly one
  representation. `isDealCurrentlyValid` checks it **before** the time window, and a window that
  crosses midnight is credited to the day it opened on — a Saturday 23:00–03:00 deal is still the
  Saturday deal at 01:00 on Sunday, not a Sunday deal nobody configured. The frontend's
  `src/lib/deals.ts` mirrors all of this for display; the two must not drift.
- **A deal varies by channel in one of two shapes, never both** — `Deal.dineInPrice`…`foodpandaPrice`
  override the flat bundle price and only apply to COMBO/OPTION_COMBO; `Deal.dineInPercent`…
  `foodpandaPercent` (added 2026-08-23) override a percentage and only apply to PERCENTAGE and
  BUY_X_GET_Y, which have no flat price to vary. `resolveChannelPercent(record, orderType, base)`
  reads them with a per-format base: `discountPercent` for a PERCENTAGE deal, `100` for
  BUY_X_GET_Y (where it means how much of the free item the deal covers, so a lower figure charges
  the customer the rest and the line is labelled "(Discounted)" not "(Free)"). `??` not `||`, so an
  explicit 0 survives — "no discount on Foodpanda" is a real setting, distinct from "no override".
  `deal.controller.ts`'s `channelPercentFields` nulls the columns on write for the flat-price
  formats; `mapDealOutPublic` folds the dine-in one into `discountPercent` for a PERCENTAGE deal
  only, since on a BUY_X_GET_Y row it means something else entirely.
- **`FoodMenuItem.costPrice` / `FoodMenuVariant.costPrice`** (added 2026-08-22) are plain persisted
  columns, not server-computed — `menu.controller.ts`'s `createMenuItem`/`updateMenuItem` just store
  whatever the client sends (`costPrice ?? 0` on the item, `v.costPrice ?? 0` per variant) with no
  backend recipe-cost recalculation. A trustworthy snapshot depends entirely on the frontend having
  computed and sent it correctly (`FoodMenuForm.tsx`) — don't assume it's server-verified.
- **`order.controller.ts`'s `validateOrderStock` is the one real "can this actually be made"
  gate** — it sums each ordered `menuItemId`/`variantId`/`qty` against `FoodRecipe` rows (filtered
  `!r.variantId || r.variantId === item.variantId`) and rejects with `ApiError.badRequest` if the
  outlet's `KITCHEN` warehouse stock (or, absent one, the chain-wide `Ingredient.currentStock`) can't
  cover it. `createOrder` always called it; `self-order.controller.ts`'s `createSelfOrder` did not
  until 2026-08-27 — self-order orders went straight through with zero stock checking. Any new
  order-creation path needs this call too, not just `revalidateDealLines`.
- **`Order.status` (PENDING→PREPARING→READY) is *derived* from per-dish KDS progress rows, never
  set directly.** Since 2026-09-01 **every** dish (deal or plain) has its own ticket:
  `OrderKitchenDealProgress` keyed `(order, kitchen, dealItemKey)`, created lazily on first kitchen
  touch — an order has **zero** progress rows at creation. `deal.revalidate.ts`'s `withDealItemKeys`
  assigns every item a `dealItemKey` (deal → `${dealLineId}#${n}`, plain →
  `p:${menuItemId||name}:${variantId||'-'}#${n}`); `seedKitchenProgress` no longer pre-creates rows,
  it only returns whether any item routes to a kitchen (for the auto-`READY` shortcut).
  `OrderKitchenProgress` (the old one-shared-row-per-order+kitchen) is still read/written but **only
  for legacy orders whose items have `dealItemKey === null`** — `updateOrderKitchenStatus` /
  `computeDerivedOrderStatus` branch `item.dealItemKey ? per-dish : shared`. Rule (unchanged, now
  per dish): a dish is ready once **every** active `Kitchen` whose `assignedCategories` include its
  category has marked that dish `ready`; the order is `READY` once every dish is. **`Kitchen` has no
  `outletId`** — so two active kitchens sharing a category (often a leftover duplicate) make every
  order of that category need readying on *both* boards or it never reaches `READY` and stalls in
  Order Monitor's Preparing column; keep each category on one active kitchen.
  `computeDerivedOrderStatus()` (added 2026-08-29) is a second copy of the rule, used by
  `deleteKitchen` — which must `deleteMany` both progress tables before `kitchen.delete` (they FK
  `Kitchen` with no `onDelete` → `Foreign key constraint failed` otherwise), then re-derives and
  promotes any now-ready open order. **No schema/DB migration was needed for the per-dish rollout** —
  it reuses `OrderItem.dealItemKey` (`VarChar(140)`) and `OrderKitchenDealProgress`'s existing
  `@@unique([orderId, kitchenId, dealItemKey])`.
  - **`updateOrderKitchenStatus` accepts `dealItemKey` (one) OR `dealItemKeys: string[]` (many).**
    The batch form ("Start All Cooking" / "Mark All Ready") upserts every targeted ticket, derives
    the order status, deducts stock and emits `order:updated` **once** — the per-dish rollout first
    shipped this as N sequential client calls, which made the button visibly slow and fanned out N
    socket reloads (fixed same day, 2026-09-01). The handler opens its `$transaction` with
    `SELECT 1 FROM "orders" WHERE id = ${id} FOR UPDATE` and re-reads `status` under that lock, so
    `deductStockForConsumedStates`'s `!alreadyConsumed` guard is race-free against a concurrent
    accept of another dish / a second KDS terminal (otherwise both read `PENDING` and each deduct
    the whole order's ingredients).
- **`getSelfOrderDeals`'s Prisma `include` must list `bogoItems`**, same as `deal.controller.ts`'s
  own `dealInclude` — it didn't (fixed 2026-08-27), so every BUY_X_GET_Y deal returned to a
  self-order customer silently fell back to the single-item `buyItemId`/`getItemId` flat mirror
  regardless of how many items the deal actually configures per side. `revalidateDealLines` was
  never affected (its own query already includes it) — only the public listing was short.
- **`getSelfOrderMenu` (self-order.controller.ts) takes an optional `?tableId=`** (added 2026-08-27,
  mirroring `getSelfOrderDeals`'s existing param) purely to resolve which outlet's kitchen stock to
  check — the menu catalog itself stays global. It loads `FoodRecipe` for every returned item and
  folds live stock into a plain `available: boolean` per item and per variant via a local
  `isVariantAvailable` helper (same `floor(stock / qtyPerUnit)`, minimum-across-ingredients rule as
  `validateOrderStock`/the frontend's `calculateFoodAvailability`) — never raw stock numbers, since
  this is a public, unauthenticated route. Omitting `tableId` makes everything come back available.
- **`getActiveOrdersForTable`'s item mapping is a manual whitelist — it must include `discount`,
  `dealId`, `dealName`, `dealLineId`** (fixed 2026-08-27; all four are plain persisted `OrderItem`
  columns, no extra query cost). It didn't, so a device reconciling a table's already-placed orders
  (a promoted host, or a second device joining an occupied table) saw any deal line's full
  undiscounted price, overstating that table's bill. Any future field added to this response needs
  adding here explicitly — it does not spread the raw Prisma row.
- **`AttendanceRecord.date`/`LeaveRequest.startDate`/`endDate` are plain `String` columns
  (`"YYYY-MM-DD"`), not `DateTime`** — never pass them through `dayBoundaries()`'s `{gte,lte}`
  range; compare against a PKT-computed string instead: `new Date(Date.now() + 5*60*60*1000)
  .toISOString().split('T')[0]`. `Reservation.date` is the opposite case — a real `DateTime
  @db.Date` column, so the boundary-range pattern IS correct there. `getDashboard`'s
  `attendanceToday` (2026-09-07) is the first place this file spells out the distinction.
- **`StockDemand`'s warehouse relations are `requestingWH`/`supplyingWH`**, not
  `requestingWarehouse`/`supplyingWarehouse` — get this wrong and Prisma throws a schema-validation
  error at query time, not a silent no-op. `PurchaseRequest.status`/`RestaurantTable.status` are
  plain `String` columns (compare as literal strings, e.g. `'PENDING'`/`'occupied'`); `StockDemand.status`
  is the real `DemandStatus` enum (member `PENDING`) — three lookalike "status" fields, two different
  shapes, verify each against `schema.prisma` rather than assuming a model's sibling follows the
  same convention.
- **`GET /api/orders`'s filter clause is built by one shared `resolveOrdersWhere(req)`** in
  `order.controller.ts`, used by both `getOrders` and `getOrdersSummary` so the two never drift.
  Params (2026-09-09): `from`/`to` (YYYY-MM-DD, supersede the legacy single `date`);
  `fromTime`/`toTime` (24h `HH:mm`, PKT wall-clock time-of-day — `Order.date` has no time part,
  so this is a **pagination-safe two-query pass**: fetch `{id, createdAt}` for the date match,
  filter in JS via `isWithinTimeOfDay`, then re-query `id: {in: matchedIds}`; missing bound →
  start/end of day; `fromMin > toMin` wraps past midnight). `parseTimeOfDay`/`isWithinTimeOfDay`
  are **exported from `order.controller.ts`** — a *second independent copy* also lives in
  `reports.helpers.ts` for `getSalesByChannel`; not unified, keep in sync. `status` and `type`
  each accept a **comma list** (`"completed,cancelled"`, `"Dine In,Take Away,Delivery"`) so a
  caller can ask for a subset without changing what an *absent* value means (Kitchen Panel / POS
  / Order Monitor / Waiter Panel all call with no status/type filter and rely on the full set).
  `type=Dine In` also matches `SELF_ORDER`. `excludeUnpaid=true` (opt-in) hides orders whose
  `paymentMethod` is null/empty/`"Pending"` or whose `cashApproved` is not true — opt-in because other callers still need to see a
  completed-but-unpaid order to collect payment on it. Requiring `cashApproved: true` keeps Sales & Orders totals 100% in sync with Dashboard's Sales By Channel.
- **`GET /api/orders/summary`** (registered **before** `/:id` in `order.routes.ts`, or Express
  matches `"summary"` as an `:id`) totals Sale/Cost/Profit/Margin across the whole filtered set
  (not one page). `getOrders` also attaches per-order `cost`/`profit` computed via `computeCogs`
  against one recipe/ingredient batch for that page's items. `loadCogsInputs(menuItemIds)` in
  `order.controller.ts` is the fourth inline copy of the "load `FoodRecipe` + `Ingredient.purchasePrice`,
  build a `CogsRecipe[]`/price map" boilerplate (`getPnlReport` / `getSalesByChannel` have their
  own) — not extracted, to keep `reports.helpers.ts` DB-free for its pure unit tests.
- **`computeCogs` (`reports.helpers.ts`) now falls back to the item-level (`variantId: null`)
  recipe** when an order line has a `variantId` but no variant-specific recipe row exists —
  mirroring `validateOrderStock`'s existing `!r.variantId || r.variantId === item.variantId`
  filter, which `computeCogs` lacked. Root-caused live: a Self-Order line (always carries a real
  `variantId` once a size is picked) costed **Rs. 0** on Sales By Channel while a POS
  "Add Without Extras" line (`variantId: null`) for the same pizza costed correctly — its recipe
  only ever existed at the item level. This under-costed **P&L** the same way, chain-wide.
- **`getSalesByChannel` merges `SELF_ORDER` into its `dineIn` bucket** (2026-09-09), matching
  `GET /api/orders`'s `type=Dine In` rule — keep the two merges in sync.
- **`splitOrderTotalByLine(orderTotal, lineGross[])`** (`reports.helpers.ts`, 2026-09-09, pure +
  unit-tested) — prorates an order's **final** `total` (tax + discount inclusive) across its
  lines by gross-value share; parts sum back to `Math.round(total)` exactly (last positive-weight
  line absorbs rounding drift; all-zero grosses → equal split). Prorating the final total, not
  the gross subtotal, keeps a per-line revenue attribution reconcilable with `getSalesByChannel`
  (which sums `Order.total`).
- **`GET /api/reports/sales-by-category`** (`getSalesByCategory`, route registered right after
  `/sales-by-channel`, 2026-09-09) — per-`FoodCategory` Sale/Cost/Profit/Margin over the same
  completed + `cashApproved` set as `getSalesByChannel` but **all channels**. Line-level: each
  order's `total` split via `splitOrderTotalByLine`, filed under each line's
  `menuItem.category.name` (null/deleted → `"Uncategorised"`); Cost is real per-line
  `computeCogs`; cancelled `OrderItem`s (`status !== 'active'`) excluded from both the split and
  the buckets — a deliberate, more-correct divergence from `getSalesByChannel`, which COGS-es
  every item row. `combined` sums all categories = every completed sale, every channel (so it
  will NOT equal `getSalesByChannel`'s `combined`).
- **`resolveOrdersWhere` `category=<name>` param** (2026-09-09) → `where.items = { some: {
  status: 'active', menuItem: { category: { name } } } }` (or `menuItemId: null` OR
  `menuItem.categoryId: null` when name is `"Uncategorised"`); matched by category **name**, not
  id, for readable drill-down URLs. `getOrders` then attaches per-order
  `categorySale`/`categoryCost`/`categoryProfit` (same `splitOrderTotalByLine` proration +
  per-line `computeCogs`, over active lines in that category only) and `getOrdersSummary`
  aggregates just that slice — so the Sales & Orders table + its summary cards reconcile with the
  Dashboard "Sales by Category" card.
- **`groupPaymentsWithCounts(rows)`** (`reports.helpers.ts`, 2026-09-09) — `groupPayments` (which
  is now a thin wrapper over it) plus a per-method `orders` count; a genuine split credits AND
  counts toward every method it used, so `Σ orders` can exceed the input row count.
  **`orderUsedPaymentMethod(methodStr, orderTotal, wanted)`** — split-aware "did this order use
  method X?", via the same canonical `parsePaymentMethodAmounts`; filtering "Cash" never matches
  a "JazzCash" order (no substring trap).
- **`GET /api/reports/sales-by-payment-method`** (`getSalesByPaymentMethod`, route after
  `/sales-by-category`, 2026-09-09) — amount / order count / % share per payment method +
  `cashAmount`/`digitalAmount`/`cashSharePct`, all channels, over the same completed +
  `cashApproved` set as `getSalesByChannel`. Amounts only — no Cost/Profit. Uses
  `groupPaymentsWithCounts`.
- **`resolveOrdersWhere` `paymentMethod=<name>` param** (2026-09-09) — Dashboard "Sales by
  Payment Method" drill-down. NOT a Prisma `contains` ("Cash" ⊂ "JazzCash"): it rides the
  existing time-of-day two-query pass (now selecting `paymentMethod`/`total` too) and keeps an
  order when `orderUsedPaymentMethod` says that method contributed a positive amount. **No
  per-order slice** — unlike `category`, `getOrders`/`getOrdersSummary` return whole-order
  figures (a split order matches every method it used).
- **`getSalesByCategory` / `getSalesByPaymentMethod` zero-fill** (2026-09-09) — `getSalesByCategory`
  appends a Rs. 0 row for every active `FoodCategory` with no sales (`"Uncategorised"` excluded —
  it only shows with real activity), sorted after the real rows by `displayOrder`.
  `getSalesByPaymentMethod` reads `Settings.paymentMethods` (Cash always added, matched
  case-insensitively so a configured "Credit Card" and a parsed "credit card" don't split) and
  appends a Rs. 0 row for each unused one. Totals unaffected (zeros add nothing).
- **`GET /api/reports/top-items`** (`getTopItems`, route after `/sales-by-payment-method`,
  2026-09-09) — per-menu-item Qty/Sale/Cost/Profit/Margin, **aggregated by `menuItemId`**
  (variants merged), all channels; `splitOrderTotalByLine` + per-line `computeCogs` (a 5th
  inline copy of the COGS-input load). `topItems` = top 10 by profit, `bottomItems` = bottom 10
  by profit — both sliced from the same aggregated set, so they overlap when ≤ 20 distinct items
  sold. Name falls back to `OrderItem.name` for a deleted item; null-`menuItemId` lines skipped.
  No new helper/tests — reuses the tested math.
- **`GET /api/reports/net-profit`** (`getNetProfit`, route after `/top-items`, 2026-09-11) —
  **Net Profit = Revenue − COGS − Food Loss (Σ `WasteRecord.cost`) − Expenses (Σ `Expense.amount`)**,
  outlet-scoped, date range only (via `getParams`; no time-of-day). The ONLY calc that subtracts
  all four — `getPnlReport` omits Food Loss, `getDashboard.netProfit` omits COGS; both unchanged.
  Also returns `grossProfit`/`grossMarginPct`/`netMarginPct`, `expenseByCategory`, `wasteByReason`
  (both value-desc, positive-only), and `purchases` (Σ `Purchase.total`, `status != 'pending'`, in
  range) — **context only, NOT subtracted** (stock bought is inventory, not a cost until
  sold/wasted). 5th inline copy of the COGS-input load. No tests (straight sums + tested
  `computeCogs`).
- **`getExpenses` / `getAdjustments` / `getWasteRecords` gained `from`/`to`** (2026-09-11,
  `YYYY-MM-DD`, either bound alone = one day — same convention as `resolveOrdersWhere`);
  `getWasteRecords` also gained `reason` (exact match). First real date-range filtering either
  endpoint has ever had — added so the Dashboard "Net Profit" section's Revenue/Food
  Loss/Expenses rows can drill into `/sales`, `/stock/adjustments`, `/expenses` pre-filtered to
  its exact window. `getAdjustments` (corrections) gets `from`/`to` too, purely so
  `StockAdjustments.tsx`'s merged waste+correction table stays date-consistent — it has no
  `reason` param.
- **Dashboard audit (2026-09-11)**: `getDashboard`'s `paymentBreakdown`/`topItems`/`month.{grossSale,
  discounts,revenue,foodLoss,netProfit}` fields are now DEAD on the frontend — the three widgets
  that read them ("Payment Methods (This Month)", "Top 10 Items (This Month)", "Financial
  Overview (This Month)") were removed from `Dashboard.tsx` as fully superseded (the last one's
  Net Profit tile was the known-wrong `Revenue − Expenses − Loss` calc, sitting right below the
  correct one). The fields themselves are left in `getDashboard`'s response — not worth a backend
  change for dead frontend fields; don't assume they're unused elsewhere without checking first.
- **`GET /api/reports/deals-performance`** (`getDealsPerformance`, route after `/net-profit`,
  2026-09-11) — redemption count + revenue (+ cost/profit where meaningful) per `Deal`, outlet-
  scoped via the underlying orders (`Deal` has no `outletId` column — chain-wide catalog overlay,
  see the Deals module's "Outlet targeting" note), date range only (via `getParams`; no
  time-of-day, same call as Net Profit). Merges two disjoint sources in one pass over one
  `prisma.order.findMany`:
  - **Line-item deals** (COMBO/OPTION_COMBO/PERCENTAGE/BUY_X_GET_Y) — `OrderItem.dealId`/
    `dealLineId` (all four types tag both, confirmed by reading `deal.revalidate.ts`; one
    `dealLineId` = one redemption). Revenue = `splitOrderTotalByLine` share (computed over ALL of
    the order's items, same as `getTopItems`, so a deal line's share is correct even when the
    order also has non-deal lines); Cost = `computeCogs` per line. 6th inline copy of the
    COGS-input load.
  - **Order-level deals** (PROMO_CODE/MIN_SPEND) — `Order.appliedDealId` (one matching order = one
    redemption, Revenue = the whole `Order.total`, not prorated). **No Cost/Profit** — not tied to
    specific items, and the discount amount isn't cleanly recoverable (`Order.discount` merges
    manual + deal discount into one figure — see the Deals money-contract section). `appliedDealCode`
    set → `PROMO_CODE` type label, null → `MIN_SPEND` (same switch `resolveOrderDiscount` uses).
  `Deal.type` isn't stored on Order/OrderItem, so it's looked up separately (`prisma.deal.findMany`
  by the collected line-deal ids only) after the aggregation pass; a since-deleted deal (`dealId`/
  `appliedDealId` are plain strings, never a formal FK) keeps its stored name with a generic
  `LINE_DEAL`/`ORDER_DEAL` type fallback. Returns `rows` (sorted by redemptions desc),
  `totalRedemptions`, `totalRevenue`, `mostUsed`, `activeDealsCount`. No tests (straight
  aggregation + already-tested `computeCogs`/`splitOrderTotalByLine`).
- **`resolveOrdersWhere` (`order.controller.ts`) gained `deal`** (added 2026-09-11, for the
  Deals Performance row drill-down): `deal=<dealId>` keeps only orders where that deal was
  redeemed — `{ OR: [{ items: { some: { dealId } } }, { appliedDealId: dealId }] }`, pushed onto
  `where.AND` (not assigned to `where.OR` directly) so it composes correctly alongside the
  `search` param's own top-level `OR`. Matched by id, same reasoning as `getDealsPerformance`.
  No per-order slice (unlike `category`) — both `getOrders` and `getOrdersSummary` inherit it
  automatically through the shared `resolveOrdersWhere`, no extra code in either.
- **`deal=` now DOES slice Sale/Cost/Profit** (added 2026-09-11, superseding the "no slice" note
  above) — `getOrders` gained a `dealFilter` branch (checked before `categoryFilter`, same
  precedence in `getOrdersSummary`'s new `if (dealFilter)` early-return block, mirroring its
  `categoryFilter` branch's shape). Per matching order: line-item deal (`items.some(dealId ===
  ...)`) → `splitOrderTotalByLine` + per-line `computeCogs`, same method as category; order-level
  deal (`appliedDealId === ...`) → whole-order total/cost, no slice possible (the discount isn't
  tied to specific lines). These two routes are mutually exclusive per order (see the
  single-discount-per-order fix below), so no order ever needs both computed.
- **Single-discount-per-order fix, `createOrder`/`updateOrder` (2026-09-11)**: added a
  `hasLineDeal = revalidatedItems.some(i => !!i.dealId)` guard before both endpoints' existing
  `resolveOrderDiscount` call. When true: `resolveOrderDiscount` is skipped (`orderDiscount =
  null`), manual `discount` is forced to `0`, and — new in `createOrder` specifically — an
  explicitly-typed `dealCode` throws `ApiError.badRequest('Cannot apply a coupon — this order
  already has a deal applied')` immediately, before the revalidated-items COGS/subtotal work
  even runs. `updateOrder`'s equivalent guard only throws when `explicitCode && codeToApply` (a
  NEW code typed on THIS edit) — a merely carried-over `appliedDealCode` from before the edit
  added a line-item deal silently drops instead, reusing the existing try/catch's `if
  (explicitCode) throw` split. `forceRecompute` (createOrder) / the always-executed block
  (updateOrder) now also fires purely off `hasLineDeal`, not just `Boolean(orderDiscount)`, so a
  line-item-deal order's subtotal/discount/total are always server-recomputed rather than
  trusting the client even when no order-level deal was ever in play.
- **`toDealForPricing` (`deal.revalidate.ts`) is now exported** — previously module-private,
  needed by `reports.controller.ts`'s `getDealsPerformance` to recompute an order-level deal's
  historical discount via `computeOrderDiscount` (see the frontend guide's mirror of this note,
  or the root CLAUDE.md Deals section, for the full `discount` field writeup).
- **`GET /api/reports/sales-by-staff` (`getSalesByStaff`, route after `/deals-performance`,
  2026-09-11)** — Orders/Sale/Cost/Profit/Margin per `Order.staffId` (`staffName` + "Unassigned"
  fallback when null), date range + optional PKT time-of-day (same `parseTimeOfDay`/
  `isWithinTimeOfDay` pattern as `getSalesByChannel`). `source` per row = distinct
  `Order.orderSource` values joined with " / ". Yet another inline COGS-input-load copy. No
  tests.
- **`resolveOrdersWhere` gained `staffId`** (2026-09-11, for the above section's row/bar
  drill-down) — a one-line `if (staffId) where.staffId = String(staffId);`, no OR-composition
  needed (unlike `deal`) since it's a plain equality that composes fine with `search`'s own
  top-level `where.OR`.
- **`reports.helpers.ts`'s `parseDateRange(from, to)` was comparing UTC midnight against a real
  UTC timestamp when it should compare PKT midnight (fixed 2026-09-12)** — `from`/`to` are PKT
  calendar-date strings, but `gte`/`lte` were built as literal `${date}T00:00:00.000Z`/
  `T23:59:59.999Z`, i.e. UTC midnight, then compared against `Order.createdAt` (a genuine UTC
  instant). Since PKT = UTC+5, any order placed 00:00–05:00 PKT landed in UTC's *previous*
  calendar day and was silently excluded from that PKT day's report window everywhere this
  function is used — `getSalesReport`/`getPnlReport` (via `getParams`), `getSalesByChannel`,
  `getSalesByCategory`, `getSalesByPaymentMethod`, `getTopItems`, `getNetProfit`/
  `getDealsPerformance` (via `getParams`), `getSalesByStaff` — i.e. every `/api/reports/*`
  date-range endpoint, all seven Dashboard sections. Same bug class as this file's own
  `AttendanceRecord.date` PKT-string note above; `parseDateRange` just hadn't been shifted like
  that pattern requires. Fixed by subtracting 5h from both `gte`/`lte` after building them;
  `reports.helpers.test.ts`'s boundary-parsing test updated to assert the shifted values.
- **Three more `/api/reports/*` endpoints (2026-09-12), all date-range only**:
  `getSalesByOutlet` (Sale/Cost/Profit/Margin per `Outlet`, same completed+cashApproved set as
  `getSalesByChannel`); `getCancellationRequestsReport` (counts by status + `byReason`/`byStaff`,
  both capped top 8 — an inconsistency with the "by X" endpoints above, which don't cap);
  `getPurchasesBySupplier` (groups `Purchase` by supplier over `Purchase.date` — a plain
  `@db.Date` column, so **no PKT shift**, plain UTC-midnight boundaries, same as `getExpenses`;
  reuses `getPurchases`' outlet-scoping OR-clause, not a plain `where.outletId`, since
  `Purchase.outletId` alone isn't reliably populated; `rows` NOT capped server-side, matching
  `getSalesByStaff`/`getSalesByOutlet`'s convention).
- **`listCancellationRequests` (`cancellation-request.controller.ts`) gained `from`/`to`/
  `reason`/`responsibleUserId`** (2026-09-12) — `from`/`to` reuse `reports.helpers.ts`'s
  `parseDateRange` (imported cross-module) via the `getExpenses`-style `from ?? to`/`to ?? from`
  optional-bound trick, since `OrderCancellationRequest.createdAt` is a real UTC timestamp like
  `Order.createdAt` and needs the identical PKT shift.
- **`getPurchases` (`purchase.controller.ts`) gained `from`/`to`** (2026-09-12) — plain
  UTC-midnight boundaries (`Purchase.date` is `@db.Date`, `Expense.date`-style, not
  `parseDateRange`'s PKT-shifted convention).
- **Two more `/api/reports/*` endpoints (2026-09-12)**: `getExpensesBreakdown` (`Expense` rows
  by category — zero-filled against `FIXED_EXPENSE_CATEGORIES` — and by day, zero-filled across
  the range; plain UTC-midnight, `Expense.date` is `@db.Date`) and `getWasteBreakdown` (same
  shape for `WasteRecord`, zero-filled against `FIXED_WASTE_REASONS`). **`getWasteBreakdown`
  deliberately mirrors `stock.controller.ts`'s `getWasteRecords` date-boundary convention (plain
  UTC-midnight), not this file's own `getNetProfit`** — even though `WasteRecord.date` is a real
  `DateTime` (`@default(now())`, no `@db.Date`) — because its Dashboard section's drill-down
  lands on `/stock/adjustments?from=&to=[&reason=]`, which `getWasteRecords` renders; matching it
  keeps totals reconcilable with that page. `getNetProfit`'s own `wasteRows` query keeps its
  existing PKT-shifted `parseDateRange` call unchanged — a known, pre-existing inconsistency
  between the two, not introduced here. `getWasteBreakdown` also takes optional `warehouseId`/
  `reason` (additive to the base `resolveOutletScope` filter, NOT `stock.controller.ts`'s
  role-based `applyStockScopeFilter`) so `StockAdjustments.tsx`'s own summary tiles can reuse it.
- **Four more `/api/reports/*` endpoints completing the Dashboard's report catalog
  (2026-09-12/13)**, each requiring its own PKT-column-shape check before writing the
  aggregation (see this file's PKT Timezone Pattern note above):
  - `getAttendanceAnalytics` (`/attendance`) — `AttendanceRecord.date` is a plain
    `String "YYYY-MM-DD"` (PKT), so a direct string range comparison, no `Date` math and no PKT
    shift at all.
  - `getReservationAnalytics` (`/reservations`) — `Reservation.date` is a plain `@db.Date`
    column, plain UTC-midnight boundaries, no PKT shift (like `getExpenses`/`getPurchasesBySupplier`).
    Gained an optional `status` filter 2026-09-13 for `Reservations.tsx`'s own reuse of this same
    endpoint (see below).
  - `getDeliveryPerformance` (`/delivery`) — `DeliveryAssignment.assignedAt`/`deliveredAt` ARE
    real UTC `DateTime` columns, PKT-shifted `parseDateRange`. `DeliveryAssignment` has **no
    `outletId` column** — scope via `order: { outletId: scope }`. Population is `status:
    'delivered'`; `returned` deliveries counted separately as a headline-only figure. Delivery
    duration (`deliveredAt − assignedAt`) is a brand-new computation nowhere else in the app.
  - `getCashSettlementTrends` (`/cash-settlements`) — `CashSettlement.createdAt` is a real UTC
    `DateTime` (PKT-shifted), `CashSettlement.outletId` lives directly on the model (no join,
    unlike `DeliveryAssignment`). Different question from `getDashboard`'s live `cashHub` field
    (a snapshot of currently-uncleared balances via `getActiveBalances`, no `CashSettlement`
    query) — this reports on settlements that already happened.
  - The `cashSettlement:` socket event had **no branch at all** in the frontend's
    `invalidateCacheForEvents` before this (not even a partial fix like the others) — fixed
    alongside `reservation:`/`delivery:`, which had the same gap.
- **`customer.controller.ts`'s `getCustomers` gained optional `from`/`to`** (2026-09-13) — when
  set, `getCustomerStatsMap(gte, lte)` scopes the Orders/Total Spent/Due computation to that
  window instead of every order ever placed, and the returned list is filtered to customers with
  at least one order in it (`mapCustomerWithStats` gained a `periodActive` flag so a customer
  with no matching stat shows 0, never a lifetime fallback). Added so `Customers.tsx` could get
  real date-range filtering — see the frontend guide for the client-side duplicate-stats bug this
  surfaced and removed.
- **`GET /api/reports/customer-analytics`** (added 2026-09-13) — New vs Returning judged against
  each customer's REAL first-ever order (an all-time, outlet-scoped fetch, not just the requested
  window): an active-in-range customer whose first order predates the window is "returning", one
  whose first order falls inside it is "new". "Who counts as a customer" mirrors
  `getCustomerStatsMap`'s dedup key exactly (customerId > clean phone (7+ digits, no dummy
  placeholders) > lower-cased name) — an order with no name or the literal "walk-in" is excluded,
  same as that function.
- **`GET /api/reports/sales-timing`** (added 2026-09-13) — promotes `getDashboard`'s old
  fixed-window "Customer Intelligence" charts (Peak Hours: this week; Order Type Trend: this
  week; Day-of-Week Performance: last 60 days — all still computed inside `getDashboard`, now
  dead/unread on the frontend, deliberately left alone rather than risk touching that large
  shared function for dead fields) into a real filterable section. Two fixes landed with the
  promotion: (1) Peak Hours/Day-of-Week bucketing used to read `getUTCHours()`/`getUTCDay()`
  directly off `Order.createdAt` with **no PKT shift** — the exact bug class this file's PKT
  Timezone Pattern note warns about, just never applied to hour/weekday buckets before; fixed by
  shifting `createdAt` +5h first. (2) "Order Type Trend" (Online/Offline) was replaced with
  "Orders by Channel" — the same Dine In/Take Away/Delivery three-way bucketing
  `getSalesByChannel` uses (Self-Order merged into Dine In), so this endpoint's channel language
  matches `getSalesByChannel` instead of introducing a second taxonomy. Online/Foodpanda/Walk-in
  orders are excluded from the channel-trend part only; Peak Hours and Day-of-Week stay
  whole-restaurant (not channel-filtered), matching the originals' scope.
- **Rider dispatch gate & delivery status guards (2026-09-20)**:
  - **Rules module (`delivery.rules.ts`)**: pure, unit-tested helpers `normalizeOrderStatus` (lowercase), `isOrderReadyForDispatch` (true only for `ready` | `completed`), `canDispatch` (`accepted` assignment AND ready/completed order), `RIDER_TRANSITIONS` (`pending -> accepted`, `accepted -> dispatched`, `dispatched -> delivered`, `dispatched -> returned`), and `isRiderTransitionAllowed`.
  - **Server guards in `updateAssignmentStatus`**:
    - *Idempotency*: if requested `status === assignment.status`, returns the current mapped assignment (200) with no side effects (prevents double-decrement of `activeDeliveries` on double-tap/retry).
    - *Ownership*: for role `Rider`, requires `assignment.rider.userId === req.user.id` else `403 Forbidden`.
    - *Rider transitions*: for role `Rider`, enforces `isRiderTransitionAllowed` else `400 Bad Request`. Manager roles stay permissive.
    - *Kitchen gate (409 Conflict)*: for ALL roles on `status === 'dispatched'`, requires assignment is `accepted` and order is `READY`/`COMPLETED` (or throws `409 'Order was cancelled'` / `'Order is not ready yet - the kitchen is still preparing it'`). Uses an interactive `prisma.$transaction` with `SELECT 1 FROM "orders" WHERE id = ${orderId} FOR UPDATE` to lock and re-verify race-free, writing `status: 'dispatched'` and `dispatchedAt: new Date()`.
  - **Schema**: `dispatchedAt DateTime?` added to `DeliveryAssignment`.
  - **Rider room & ready event**: `riderRoom(riderId)` (`rider:<id>`), `emitToRider(riderId, event, payload)`. Rider sockets join `rider:<id>` during `socketAuth`. Transitioning an order into `READY` (`runOrderStatusPostEffects`, `deleteKitchen` promotion) queries active `pending`/`accepted` assignments and emits `delivery:order_ready` to the assigned rider. `assignRider` includes `orderStatus` in `delivery:assigned`.
  - **Enriched `GET /delivery/my-assignments`**: adds `orderStatus` (lowercase), `canDispatch` (boolean), `items[]` (`{ name, qty, notes }` of active items), and selects `subtotal`/`tax`/`discount` on order so `mapAssignment` returns real numbers instead of fake 0s.
- **FCM push notifications & device token registration (2026-09-20)**:
  - **`notifications` module**: `push.service.ts` singleton lazy-initializes `firebase-admin` via modular SDK (`firebase-admin/app`, `firebase-admin/messaging`). Best-effort non-throwing `sendPushToUser(userId, payload)` queries registered device tokens, uses `sendEachForMulticast`, and self-cleans stale/invalid tokens (`messaging/registration-token-not-registered`, `messaging/invalid-registration-token`). Fails soft with a single warning if Firebase credentials are unset.
  - **Endpoints**: `POST /api/notifications/device-token` (upserts token keyed by token string, stamps `userId = req.user.id`, captures optional `platform`), `DELETE /api/notifications/device-token` (scoped to `userId: req.user.id`, deletes specified token). Both require `authenticate`.
  - **Schema**: `DeviceToken` model (`id`, `userId` FK User cascade delete, `token` @unique, `platform`, timestamps, `@@index([userId])`).
  - **Delivery triggers wired**:
    - *New assignment*: `delivery.controller.ts` (`assignRider`) sends push `"New Delivery Assigned"` to `rider.userId`.
    - *Order ready for pickup*: `order.controller.ts` (`runOrderStatusPostEffects` and `deleteKitchen` promotion) queries active assignments on the order and sends push `title: 'Order Ready', body: 'Order <orderNumber> is ready for pickup'` to `assignment.rider.userId`.
- **Rider self-service read APIs & wallet fix (2026-09-20)**:
  - **Endpoints (all `authenticate, authorize(riderRoles)`)**:
    - `GET /api/delivery/my-profile`: returns `{ ...mapRider(profile), user: { id, name, email, phone, outlet: { id, name } } }`.
    - `PATCH /api/delivery/my-status`: body `{ isAvailable: boolean }`. If current `status === 'on_delivery'`, rejects with `400 'Cannot go offline while on an active delivery'`. Otherwise updates `isAvailable` and `status: isAvailable ? 'available' : 'offline'`, returning `mapRider`.
    - `GET /api/delivery/my-history`: paginated (`page`, `limit` capped at 100) `DeliveryAssignment` rows with `status: { in: ['delivered', 'returned'] }` for caller's riderId, newest first (`assignedAt: desc`), mapped via `mapAssignment`. Optional `from`/`to` filtered on `deliveredAt` (fallback `assignedAt` if `deliveredAt` is null). Returns `ApiResponse.paginated`.
    - `GET /api/delivery/my-earnings`: query `from`/`to` (defaults to current PKT week Monday to today via `getDefaultWeekRange`). Returns `totalOrders`, `totalSales`, `totalCommissions`, and `breakdown` array with `{ date, orders, sales, commissions }` across the range (zero-filled for days with no activity).
    - `GET /api/delivery/rankings`: leaderboard visible to all outlet riders (scoped via `resolveOutletScope`). Query `from`/`to` (defaults to current PKT week). For all active riders in scope, counts deliveries and sums `commissionEarned`, sorted by total commission descending. Zero-activity riders are included with 0s.
  - **Wallet fix on `GET /api/delivery/my-stats`**: removed buggy `pendingCash` field which previously looked only at today's deliveries, silently hiding uncleared cash from previous days. Pointed readers to canonical endpoint `GET /api/cash-settlements/staff/:staffId/active` with `staffId = req.user.id`.

## Step 7 Additions (Rider App: Wallet, Earnings, History, Profile)
- **Leaderboard, history filters & wallet method fields (Step 7, 2026-09-21)**:
  - `GET /api/delivery/rankings` returns `[{ riderId, name, deliveries, rank, isMe, commissionEarned? }]`, built by pure `rankRiders(rows, callerRiderId, includeAllCommission)` in `src/modules/delivery/delivery.helpers.ts`: sorted by deliveries desc then name asc, with **competition ranking** (ties share a rank and the next rank skips: 1, 2, 2, 4). Privacy: `commissionEarned` is present only on the caller's own row, or on every row when the caller is Super Admin/Admin/Manager; other riders' rows omit the field entirely. Riders with zero deliveries are included. No web client consumes this endpoint.
  - `GET /api/delivery/my-history` gained `status` (`delivered` | `returned`; any other value returns 400) and `q` (case-insensitive "contains" match on the **order number only**), AND-composed with the existing `from`/`to` clause. `mapAssignment` now adds `paymentLabel` to every assignment it returns (my-assignments and status-update responses too), derived by pure `deriveHistoryPaymentLabel(status, paymentMethod)`: returned / empty / `Pending` / `Unpaid` give `null`; `COD Balance (X)` gives `X`; `Advance (X)` with no COD part gives `X`; a split such as `Cash: Rs.900, JazzCash: Rs.779` gives `Cash + JazzCash`; a plain method name is returned unchanged. Clients must never parse `COD Balance (...)` strings themselves.
  - Cash Hub / wallet: every order inside a `getActiveBalances` staff group (so also `GET /cash-settlements/staff/:staffId/active`) now carries `methods`, a `{ method: amount }` map of the non-zero methods that make up that staff member's portion, produced by exported pure `nonZeroMethods(parsedAmounts)` in `cash-settlement.service.ts`. The group-level `byMethod` is unchanged (still zero-filled from `Settings.paymentMethods`).


<!-- code-review-graph MCP tools -->
## Reservation advances in Cash Hub (2026-10-12, owner: "Track who took the advance")
- **Who took it:** `Reservation.advanceCollectedById/Name/At` are stamped with the logged-in staff member when a
  booking is created or edited with `advancePaid > 0` and no collector yet (pure `reservation.advance.ts`, tested).
  Advances recorded before this have no collector ("untracked") and behave as before.
- **Cash Hub line:** a tracked advance (collector set, `advanceSettlementId` null, `advanceRefunded` false) is its
  own line on the collector's balance in `getActiveBalances`, channel `RESERVATION_ADVANCE_CHANNEL` =
  `'Reservation Advance'`, from the moment it is recorded (a no-show's too). `createSettlement` claims it with
  `reservation.updateMany({ advanceSettlementId: null, advanceRefunded: false })` + a count guard, like orders;
  settlement history lists it via `reservationAdvances` (`mapReservationAdvance`, `orderNumber` "Booking <date> <time>").
- **Cancel:** the staff app asks "was the advance refunded?" and sends `advanceRefunded`. `advanceChangesOnUpdate`
  allows `true` only for a cancelled booking whose advance is neither settled nor on an order; re-opening clears it.
  It also refuses changing the amount once settled or on an order. `deleteReservation` refuses a booking with an
  open advance (`advanceDeleteBlock`) — cancel it instead.
- **Paying the rest:** `Order.reservationId` (no FK, indexed) marks the order that carries a tracked advance. Set
  server-side only: `convertReservationToOrder`; `createOrder`/`updateOrder` `reservationId` (POS loaded booking,
  Waiter Pay Bill) through `loadAdvanceReservation` — ignored when the booking is gone, of another outlet or
  untracked; 409 when another order already has it; `advancePayment` is then taken from the booking.
- **`classifyOrderCash(order)`** (extracted from `getActiveBalances`, tested) is the per-order cashier/rider split.
  With `reservationId` set the cashier gets total − advance (for an `Advance (…), Net (…)` string: only the
  `parseNetParts` parts). An untracked `Advance + Net` string now credits advance + net — it used to drop the net.

## Website online payment — Safepay (2026-10-12, owner)
- **Module `src/modules/payments/`:** `safepay.ts` (our own client matching SDK `@sfpy/node-sdk` 3.0.2: `POST /order/v1/init` → tracker,
  checkout URL with `beacon`, return `sig` = HMAC-SHA256(v1Secret, tracker), webhook `x-sfpy-signature` = HMAC-SHA512(webhookSecret,
  JSON.stringify(body.data)); tested), `payment.rules.ts` (pure, tested), `payment.service.ts` (DB), `payment.controller.ts` + `payment.routes.ts`
  at `/api/payments`. Env (all optional, all four = on): `SAFEPAY_ENV` (sandbox|production), `SAFEPAY_API_KEY`, `SAFEPAY_V1_SECRET`,
  `SAFEPAY_WEBHOOK_SECRET`. The SDK has **no refund call**: refunds are done in the Safepay dashboard.
- **Flow:** `POST /website/orders` `paymentChoice: 'online'` (default `cash`; needs `websiteConfig.onlinePayment` and the keys, else 409)
  creates the order as **`OrderStatus.AWAITING_PAYMENT`** without `order:created`, starts a tracker and returns `checkoutUrl` (null if
  Safepay is down). `POST /api/payments/safepay/return?pid=` (signed) and `/webhook` (signed) both run `confirmPayment(tracker)`:
  locks the order row; `decideConfirm` → activate (PENDING + `paymentMethod 'Online (Safepay)'` + `order:created`) / mark-paid
  (switched-to-cash, still unpaid) / refund-only. `POST /website/orders/:id/pay` (retry) and `/pay-cash` (→ normal cash order). An
  order still unpaid 30 min after its latest checkout was opened (or after it was placed) is cancelled "Payment not completed" by
  `expireStalePaymentOrders` (`payments: { none: { createdAt >= cutoff } }`) on read paths only (status, my orders, pay, pay-cash,
  refunds-due). The two Safepay paths skip CORS in `app.ts` (Safepay's domain would 500 the origin check).
- **Hidden until paid:** `resolveOrdersWhere` adds `status: { not: 'AWAITING_PAYMENT' }` when no status is asked for; also the sales
  report count, the dashboard live-status groupBy, unassigned deliveries and customer stats. Reports already filter COMPLETED.
- **Money:** `classifyOrderCash` returns null for `Online (Safepay)` (bank, not a drawer). Riders collect 0 (already true for any paid
  method). `updateOrder` on a paid-online order refuses (409) another `paymentMethod` or a total above what was paid
  (`onlinePaidEditBlock`).
- **Refunds:** `OrderPayment` (`order_payments`: tracker unique, amount, status initiated|paid, `refundedAmount`). Refund due is
  **derived** (`refundsDueForOrder`): cancelled / paid another way / duplicate → full; the kept payment owes `amount − total` when items were
  removed; minus `refundedAmount`. `GET /api/payments/refunds-due`, `POST /api/payments/:id/refunded` (website-order approver roles; guarded
  update so a double click records once). Customer status views carry `payment: { status: awaiting|paid|refund_pending|refunded, amount,
  refundDue } | null`.
- **Return never fails the customer:** if `confirmPayment` throws after a valid return signature, `safepayReturn` logs it and still 303s with `?payment=done` (the webhook confirms). `GET /api/payments/refunds-due` finds candidates with one raw-SQL pre-query (cancelled / not `Online (Safepay)` / paid twice / paid above total, with something unrefunded), then `refundsDueForOrder` — no row cap.
- **To confirm in the sandbox:** amount unit (rupees assumed), the redirect POST fields, the webhook payload (`webhookTracker` guesses
  `data.tracker` + `payment:created`/`PAID`/`TRACKER_ENDED`), a tracker status lookup. Schema arrives with the deploy's `db:push` (additive).
- **Sandbox run 2026-10-13 (ORD-047, paid with test card 4456 5300 0000 1005) — this supersedes the return and "signed" wording above:**
  - **What Safepay really does:** the amount is in **rupees**. It sends the browser back with a **GET**, no `sig`, and appends
    `?order_id=…&tracker=…` to our redirect URL even though it already has a query (so `pid` reads `<id>?order_id=…`). No webhook
    arrived (both dashboard logs stayed empty). The POST-only route answered 404, so the paid order stayed AWAITING_PAYMENT.
  - **Fix (same day): Safepay's own record is the source of truth.** `safepay.ts` `fetchTracker` = `GET {API}/order/v1/{tracker}` (no
    auth; the docs' `/reporter/api/v1/payments/{tracker}` does not find these trackers) and pure `isTrackerPaid` (tested): state
    `TRACKER_ENDED` + a transaction on our `client` for the amount whose `signature` = HMAC-SHA256(Secret key, tracker). A started
    tracker reads `TRACKER_STARTED`, a cancelled one `TRACKER_CANCELLED`.
  - `payment.service.ts` `settlePayment` looks a tracker up and confirms it ('paid' | 'unpaid' | 'unknown', never throws). The return
    (`GET` or `POST /safepay/return`) trusts nothing in the request and uses it; paid at Safepay redirects `?payment=done` even if the
    save failed. The customer's reads call `refreshPaymentOrders` (status, my orders, pay, pay-cash), which settles their open
    checkouts first, so a paid order heals without any return or webhook and "Pay now" can't start a second payment.
    `expireStalePaymentOrders` asks Safepay before cancelling and leaves an order it couldn't ask about for the next read.
  - Dashboard "Public key" = `SAFEPAY_API_KEY`, "Secret key" = `SAFEPAY_V1_SECRET`.
  - **Cards only (checked 2026-10-13 in the checkout page's own code, sandbox and production builds):** its method switcher renders only
    "Card payment". Pages for wallets (Easypaisa; JazzCash through PayFast; Abhi) and bank accounts (PayFast / NIFT) exist in that code,
    but the page opens them only when cards are NOT enabled for the merchant, and Raast is not in it at all. Our sandbox capabilities
    (`GET /order/payments/v2/capabilities?tracker=`) are `CYBERSOURCE` + `PAYFAST`. The dashboard's intent chart (Abhi, Easypaisa,
    Payfast, Nift, Cybersource) lists the same types. So Easypaisa / JazzCash need another gateway (PayFast covers both plus bank
    accounts and Raast) or direct integrations. Owner's decision pending.
  - **Still unconfirmed:** webhooks (`webhookTracker` and the webhook signature have never run against a real one).
- **Deploy steps:** set the four `SAFEPAY_*` vars on the Railway service; register `https://<api host>/api/payments/safepay/webhook` as the webhook URL in the Safepay dashboard; the production website origin must be in `CORS_ORIGIN` (only `*.vercel.app` and localhost are allowed by pattern) or online payment is refused with 400 'has to be started from the Ovenisto website'; switch on Settings → Website → Accept online payment per branch.
- **Final-review hardening (2026-10-12):** `POST /safepay/return` is rate-limited (60/min per IP; the webhook is not, its HMAC check runs before any DB work) and finds the payment by the posted `tracker` when `?pid=` is missing (the signature is still checked against that row); `webhookTracker` refuses an event whose `type` names a failure (`fail|cancel|expire|error|declin|void|refund`) even when the state looks paid; `readSafepayConfig` trims all four values and counts a blank one as missing; `emitOrder` is best-effort (try/catch + `console.error`) so a socket or read error after a committed change never becomes a 500; `markRefunded` keeps a stored `refundReference` when none is sent; `getActiveBalances` no longer loads `Online (Safepay)` orders at all (`classifyOrderCash` still skips them).

## Website extra sections (2026-10-14, uncommitted)
From the owner's mockup PDFs; staff control all of it from the staff app (no website admin panel).
- **Schema (additive; pushed to the staging DB 2026-10-14 with the owner's OK; production gets it on deploy):**
  - `FoodMenuItem.isNew Boolean @default(false)` and `FoodMenuItem.advanceHours Int?`.
  - New tables: `coming_soon_dishes` (chain-wide, with a `votes` counter), `dish_suggestions`, and
    `event_inquiries` (per outlet, `status` = new | contacted | closed).
  - This code on a DB without the columns fails every menu read (Prisma selects them), so push the schema first.
- **First-order discount:**
  - Stored as `websiteConfig.firstOrderDiscount {enabled, percent 1–90}` (`parseFirstOrderDiscount`).
  - `priceWebsiteCart` applies it only for a signed-in customer; the quote route now runs
    `optionalWebsiteCustomer`.
  - Never with a line deal or a typed code. It replaces a Minimum Spend auto deal only when bigger.
  - Eligible = no earlier non-cancelled website order with the same `customerUid` or phone (`isFirstWebsiteOrder`).
  - It comes back as `appliedDeal = {dealId: null, code: null, dealName: "First order N% off"}`.
  - `/config` returns `firstOrderDiscount: {percent} | null`.
- **Advance dishes (`advanceBlock`):**
  - Website reservations only (owner's rule, 2026-10-14): a booking needs `booking time − now ≥ advanceHours`.
  - The reservation quote checks only when both `date` and `time` are sent.
  - Orders are never checked: `/website/quote` + `/website/orders`, self-order and staff orders take the dish any
    time. `advanceBlock`'s `bookingMs: null` branch ("for now") is unused since then.
- **Public endpoints:**
  - `GET /website/best-sellers?outletId=`: `{menuItemIds}`, the top 8 by qty from completed orders in the last
    30 days.
  - `GET /website/coming-soon`.
  - `POST /website/coming-soon/:id/vote`: 20/min/IP. The website allows one vote per dish per browser; the server
    only counts.
  - `POST /website/suggestions` and `POST /website/event-inquiries`: 5/min/IP. Event date from tomorrow to 365
    days ahead, guests 10–2000, `EVENT_TYPES`.
- **Staff endpoints, `/api/site-content` (`site-content` module):**
  - Coming-soon CRUD and suggestions list/delete: Super Admin / Admin / Manager.
  - Event inquiries list (outlet-scoped) and `PATCH /:id {status}`: the same roles plus Floor Manager.
- `menu.controller` create/update accept `isNew` and `advanceHours` (`normalizeAdvanceHours`: 1–720, else null).
- Typecheck clean, 543 tests (30 files).
- **"Inside our kitchen" posts (2026-10-24, uncommitted; schema pushed to staging 2026-10-24):** `KitchenPost` model
  (`kitchen_posts`: title, body, `images String[]`, `videoUrl`, `isPublished`), chain-wide. Staff CRUD at
  `/api/site-content/kitchen-posts` (CONTENT_ROLES; zod: max 10 https photos, video must pass `toVideoEmbedUrl`).
  Public `GET /website/kitchen-posts?limit=` (1-50, default 20) and `/website/kitchen-posts/:id`, published only.
  Pure `site-content.helpers.ts` `toVideoEmbedUrl` (tested) turns a YouTube / Instagram link into its embed URL and
  refuses every other host; responses carry it as `videoEmbedUrl`. Videos are links on purpose (no video uploads).

## Public Website API (/api/website)
- **Endpoints:** `GET /api/website/outlets`, `/api/website/config`, `/api/website/menu`, `/api/website/deals`, `POST /api/website/quote`, `POST /api/website/orders`, `GET /api/website/orders/:id/status`.
- **Customer sign-in (2026-10-10):**
  - **Gate:** `POST /website/orders` and `POST /website/reservations` require a signed-in website customer, and so do the new `GET /website/my/orders` + `/website/my/reservations` (newest 50, the same views as the `/status` endpoints). Browsing, quotes and status stay public.
  - **Token check:** `website.auth.ts` `requireWebsiteCustomer` verifies the Firebase ID token (project `ovenisto-rider`, `FIREBASE_PROJECT_ID` else that default) and puts its uid on `res.locals.customerUid`; a missing or bad token gives 401. It uses its own named firebase-admin app `website-customers` with only a project id: verifying needs Google's public keys, not the push service account.
  - **Email verification (2026-10-10):** an email + password account whose address isn't verified gets **403** "Please verify your email address first" (pure `isUnverifiedEmailAccount(claims)`: `firebase.sign_in_provider === 'password'` and `email_verified !== true`; tested). Google and phone tokens pass, since their provider verified them. The website re-fetches the token (`getIdToken(true)`) after the customer verifies, because the claim lives in the token.
  - **push.service fix:** `getFirebaseApp` now reuses only the `[DEFAULT]` app. Before, it took `getApps()[0]`, which could be the credential-less customer app.
  - **Storage:** the uid is stored on `Order.customerUid` / `Reservation.customerUid` (`VarChar(128)`, nullable, indexed, not unique). `signedInUid()` guards the `/my/*` queries so a missing uid can never become `where: { customerUid: undefined }` (= every row).
  - **Tests and DB:** pure `parseBearerToken` has tests in `website.helpers.test.ts`. The columns need `npm run db:push`. Until then the regenerated client makes every order/reservation read fail with "Database error".
- **Opening hours (2026-10-11):** `websiteConfig.hours {open, close}` (24h "HH:mm", PKT; close ≤ open = after midnight), parsed by pure `parseHours` (two valid, different times, else null; tested) inside `readWebsiteConfig`, and returned per branch by `GET /website/outlets` as `hours`. No schema column; branch Admins set it in staff Settings → General (it still lives in `websiteConfig`). Orders are not gated by it.
- **Meal times (2026-10-11):** `websiteConfig.mealHours {[mealTypeId]: {open, close}}` (pure `parseMealHours`, each entry through `parseHours`). `GET /website/menu` adds `mealTypes [{id, name, hours|null}]` (active MealTypes + this branch's hours) and `publicMenu.ts` adds `mealTypeIds` to every item (self-order too). `priceWebsiteCart(..., servedAt: {minute, hint})` refuses a plain line whose dish isn't served at that PKT minute with 400 `"X" is only served during Breakfast (8:00 AM – 11:00 AM). <hint>`. Rule (pure `isServedAt`, `inHoursWindow` wraps past midnight): untagged dishes, and dishes with any meal type that has no hours or is inactive, are always served. Quote/orders check `pktMinuteNow()`; reservations check the booking `time` (create always, `/reservations/quote` once the new optional `time` "HH:mm" is sent). Deal lines are not meal-checked. Tested in `website.helpers.test.ts`.
  - **Shared helper `src/modules/menu/mealTimes.ts`** (same day, owner: "hr jaga"): `loadBranchMealTypes(prisma, outletId)` (active MealTypes + the branch's `mealHours`, settings row ?? first row) and `assertServedAt(dish, mealTypes, minute, hint)` (the 400; tested in `menu/__tests__/mealTimes.test.ts`). Used by website getMenu + `priceWebsiteCart`, and by self-order: `GET /self-order/menu` returns `mealTypes`, `createSelfOrder` refuses an unserved plain line ("Please remove it from your order."). Staff `createOrder` (POS/Waiter) is NOT checked on purpose — an offline-synced order or an edit of an order placed in time would be refused later; the staff screens block it instead.
  - `GET /website/outlets` also returns `mealTimes [{name, open, close}]` per branch (active meal types with a time, sorted by start; pure `listMealTimes`, tested).
- **Branch location (Step 10, 2026-10-06):** `websiteConfig.location {lat,lng}`, read by `readWebsiteConfig` through pure `parseLocation` (finite numbers or numeric strings, in range, `(0,0)` rejected, else `null`). `GET /website/outlets` returns `location` per branch; the website uses it to auto-select the nearest branch. No schema column; branch Admins set it in staff Settings → Website.
- **Website reservations with pre-orders (Step 12a, 2026-10-07):**
  - **Endpoints and types:**
    - `WEBSITE_BOOKING_TYPES` (Dine In / Take Away / Delivery) is accepted by `/website/menu`, `/website/deals` (Dine In → `availableDineIn: true`), the new `POST /website/reservations/quote` and `POST /website/reservations`.
    - Orders and `/website/quote` keep `WEBSITE_ORDER_TYPES`.
  - **Pricing:** reservations price through `priceWebsiteCart(..., checkStock: false)` (a future booking isn't refused on today's stock; no coupon code).
  - **Storage:**
    - `preOrderItems` uses the staff line shape. `attachDealTags` puts back the client's `dealGroupId`/`dealRole`, which `revalidateDealLines` drops but `convertReservationToOrder` needs when it revalidates again.
    - New `Reservation.discount`/`deliveryFee`/`deliveryLat`/`deliveryLng`; `mapReservation` numbers the two Decimals.
    - bookingType is `table_reservation` (Dine In) or `future_order`.
  - **Convert:** `convertReservationToOrder` copies discount, delivery fee and coordinates to the order; its `$transaction` has `{ timeout: 30000 }` (P2028 at the 5 s default when tested over the public proxy).
  - **Dedupe (fixed 2026-10-08 after the Step 12b live test):** `createWebsiteReservation`'s `findFirst` matches outlet + phone + date + time + **`orderType`** (+ website, pending/confirmed). For a hit, pure `preOrderSignature` (`website.helpers.ts`: item, size, qty, modifiers, deal per line; order-independent; prices and the client `dealLineId` ignored; normalises the client's `modifierIds: string[]` vs the stored `[{ modifierId, qty }]`) decides: same pre-order → the existing booking is returned (double-submit); different → `409 "You already have a pickup booking at HH:mm on YYYY-MM-DD…"`. Before, any second booking at the slot silently got the first one back and the website cleared the new cart. A different type at the same slot is a separate booking.
- **Delivery live location (Step 11, 2026-10-07):** `Order.deliveryLat`/`deliveryLng` (`Float?`). `POST /website/orders` accepts optional `deliveryLocation {lat,lng}` and stores it only for Delivery via pure `resolveDeliveryLocation(orderType, value)` → `parseLocation` (else both null). Every order `select` in `delivery.controller.ts` includes the two fields (`mapAssignment` spreads `a.order`), and `mapUnassignedDeliveryOrder` copies them explicitly — keep both in sync when adding a delivery query. Pushed to the staging DB 2026-10-07; production adds the columns on deploy (additive, no data-loss flag).
- **Caching (Step 9, 2026-10-06):** the four read endpoints send `Cache-Control: no-cache`. They used to send `public, max-age=60` (outlets 300), and browsers then kept staff changes (ordering off, an item out of stock) off the website for minutes, even across reloads. Express's weak ETag turns an unchanged response into a 304. The status endpoints send `no-store`. Don't reintroduce `max-age` here.
- **websiteConfig:** Parsed flexibly to handle legacy keys (`deliveryCharges` → `deliveryFee`, `prepTime` → `prepTimeMinutes`) and numeric strings, with canonical keys winning and defaults when unset or invalid.
- **Shared Menu Builder:** `buildPublicMenu` in `src/modules/menu/publicMenu.ts` powers both self-order and website, isolating pure mapping (`toPublicMenuItem`) from DB lookup. Allows passing an optional `orderType` to fold channel pricing.
- **Trust Proxy:** `app.set('trust proxy', 1)` added to `app.ts` to correctly identify client IPs behind Railway's proxy, ensuring rate-limiters (like `readLimiter`) track real users.
- **Ordering is closed by default:** `websiteConfig.enabled` defaults to `false`; `acceptingOrders = outlet.isActive && Settings.onlineOrders && websiteConfig.enabled`. Settings lookup = the outlet's own row `?? findFirst()` (same as `createSelfOrder`), tax default 16, currency `Rs.`.
- **`mapDealOutPublic(deal, orderType = 'Dine In')`** now takes a channel — always call it through an arrow (`.map((d) => mapDealOutPublic(d))`); `.map(mapDealOutPublic)` passes the array index as `orderType`.
- **Legacy `ORDER_DISCOUNT` deals:** website deals exclude them; one still exists in prod (the Deals split backfill never ran) and `/self-order/deals` still lists it as a card.
- **Step 2 (accepted 2026-09-29, live-tested on the DHA branch):**
  - **One pricing path:** `website.pricing.ts` `priceWebsiteCart()` backs both `POST /quote` and `POST /orders`. Plain lines are priced from the DB (`resolveChannelPrice` on the variant or item, plus active linked modifiers; the name is server-derived as `Item (Variant)`). Deal lines are only those with `dealId && dealLineId` (anything else is priced as plain — a dealId without dealLineId used to come back unpriced/free). Single-discount rule and `resolveOrderDiscount` match `createOrder`. `tax = Math.round(taxable × rate)`, `deliveryFee` (Delivery only, free at `freeDeliveryAbove`), `minOrder` applies to Delivery only. Quote never throws for a closed branch — it returns `acceptingOrders: false`; create returns 409.
  - **Orders:** created PENDING, `orderSource: 'website'`, `paymentMethod: 'Pending'`, `staffName: 'Website'`, `cashApproved: true`, number from `generateOrderNumber()`, phone stored as `03XX-XXXXXXX`, customer linked by exact phone and NEVER renamed, `clientRequestId` idempotency. `GET /orders/:id/status` only answers for website orders and maps to `pending | accepted | preparing | ready | out_for_delivery | completed | cancelled` (no PII).
- **Step 3 (accepted 2026-09-29, live-tested on DHA):** Added table reservations (`POST /api/website/reservations`, `GET /api/website/reservations/:id/status`). Gated by `reservationsEnabled` in `websiteConfig` (default false). `validateReservationSlot` safely enforces future PKT time and max advance days. Uses shared `findOrCreateWebsiteCustomer` logic. Responses never expose PII.
  - **Acceptance (self-order + website, `order/order.acceptance.ts`):** `acceptOrder`/`rejectOrder` at `/orders/:id/accept|reject` (legacy `accept-self-order`/`reject-self-order` aliases kept). Accept stamps the staff member and leaves the order PENDING for the kitchen — except an order with no kitchen-routed item goes READY with stock deduction (self-order drinks-only orders used to go READY at creation, skipping acceptance). `updateOrderStatus` (→ preparing/ready/completed), `updateOrderKitchenStatus`, `assignRider` and claim return **409** while awaiting acceptance; `getMyAssignments` hides such orders; a website Delivery order emits `delivery:unassigned` on accept, not on create. **Who may approve a website order (2026-10-11, owner):** pure `canApproveOrder(order, role)` in `order.acceptance.ts` (tested) makes `acceptOrder`/`rejectOrder` answer **403** for a website order unless the role is Super Admin / Admin / Manager / Delivery Manager (the roles that have Order Monitor, the only place the staff app approves them now); self-orders keep the route's roles.
  - **Pickup payment (2026-10-12, owner):** a website Take Away order is paid at the POS counter. Pure
    `isUnpaidWebsitePickup(order)` in `order.acceptance.ts` (tested) = `orderSource === 'website'` + `TAKE_AWAY`
    + payment missing/`Pending`/`Unpaid`. While it holds, `updateOrderStatus` → COMPLETED and any `updateOrder`
    that sets `status`/`paymentMethod` into a completed+unpaid state answer **409**
    `UNPAID_WEBSITE_PICKUP_MESSAGE` — the order is saved `cashApproved: true`, so completing it unpaid counted it
    as revenue in every report while Cash Hub (which skips `Pending`) had the money on nobody's balance.
    Recording the payment re-stamps `staffId` to the cashier (existing `updateOrder` rule) and
    `getCashierChannel` labels that cash `'Website Pickup'`. Website deliveries are unchanged (the rider's
    "delivered" writes `COD Balance (…)`).
- **deliveryFee:** `Order.deliveryFee` (pushed to the DB 2026-09-29), included in `total`, never taxed; returned by `mapOrderOut`, the rider-API assignment DTOs and quotes.
- **Branch contact on `GET /outlets` (Step 8a, 2026-10-01):** `address`/`phone`/`email` come from pure
  `website.helpers.ts` `resolveBranchContact(outlet, settings, outletId)`. The branch's OWN Settings row
  wins (what branch staff edit and receipts print), the Outlet row is the fallback, and a Settings row of
  another branch is ignored — `getOutletSettings` falls back to the first row, which belongs to Main.
  `city` comes from Outlet only. In prod the Outlet rows still hold Karachi seed data (DHA's Outlet says
  "Clifton, Karachi" while its Settings has the real Lahore address), so the website never shows `city`.
- **Step 4b (accepted 2026-09-30) — settings row lookup:** `GET /api/settings/mine` (`authenticate`)
  returns the caller's own outlet row through `findCallerSettings(req)` in `settings.controller.ts`, the
  same helper `updateSettings` uses, so read and write always pick the same row. A user whose outlet has
  no settings row gets 404 (no fallback to another branch's row). `getOutlets`' `acceptingReservations =
  o.isActive && config.reservationsEnabled`.
- **Step 4c (2026-09-30) — every branch reads its own Settings row:**
  - **`GET /api/settings` runs `optionalAuth`:**
    - a branch user → their own row (`findCallerSettings`);
    - a Super Admin → the `X-Outlet-Id` branch's row, else a chain view (the first row with
      `paymentMethods` = the union of all branches);
    - logged out → the `?outletId=` row, else the first row (the public self-order page uses this);
    - a Bearer header that optionalAuth rejected → 401 (so the client refreshes instead of getting Main's
      row).
  - **`findCallerSettings` (PUT, `/mine`) refuses Super Admin by ROLE**, not only a missing outletId:
    `admin@ovenisto.com` is a Super Admin linked to DHA.
  - **Payment-method lists:** `settings.service.ts` `getConfiguredPaymentMethods(outletId | null)` gives one
    branch's list, or the union for chain-wide (`settings.helpers.ts` `mergePaymentMethods` — pure,
    unit-tested). Used by cash-settlement `getActiveBalances` / `getStaffActiveBalance` and the reports
    Sales-by-Payment-Method zero-fill; don't read `prisma.settings.findFirst()` for this again.
  - **New outlets:** `createOutlet` creates the outlet's Settings row in the same transaction.
- Full status of the 8-step website plan lives in the root `CLAUDE.md` ("Public Website Integration").

## MCP Tools: code-review-graph

**IMPORTANT: This project has a knowledge graph. ALWAYS use the
code-review-graph MCP tools BEFORE using Grep/Glob/Read to explore
the codebase.** The graph is faster, cheaper (fewer tokens), and gives
you structural context (callers, dependents, test coverage) that file
scanning cannot.

### When to use graph tools FIRST

- **Exploring code**: `semantic_search_nodes` or `query_graph` instead of Grep
- **Understanding impact**: `get_impact_radius` instead of manually tracing imports
- **Code review**: `detect_changes` + `get_review_context` instead of reading entire files
- **Finding relationships**: `query_graph` with callers_of/callees_of/imports_of/tests_for
- **Architecture questions**: `get_architecture_overview` + `list_communities`

Fall back to Grep/Glob/Read **only** when the graph doesn't cover what you need.

### Key Tools

| Tool | Use when |
|------|----------|
| `detect_changes` | Reviewing code changes — gives risk-scored analysis |
| `get_review_context` | Need source snippets for review — token-efficient |
| `get_impact_radius` | Understanding blast radius of a change |
| `get_affected_flows` | Finding which execution paths are impacted |
| `query_graph` | Tracing callers, callees, imports, tests, dependencies |
| `semantic_search_nodes` | Finding functions/classes by name or keyword |
| `get_architecture_overview` | Understanding high-level codebase structure |
| `refactor_tool` | Planning renames, finding dead code |

### Workflow

1. The graph auto-updates on file changes (via hooks).
2. Use `detect_changes` for code review.
3. Use `get_affected_flows` to understand impact.
4. Use `query_graph` pattern="tests_for" to check coverage.

