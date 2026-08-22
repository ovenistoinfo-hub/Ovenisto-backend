# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

> The repo-root `../CLAUDE.md` holds the full project guide (architecture, module map,
> roles, env vars, deployment gotchas, the Outlet Scoping access-control model). It loads
> alongside this file in backend sessions — read it first. Below are only the gotchas
> specific to editing this backend that are easy to trip on.

## Commands

- Install: `npm install` (a fresh clone has no `node_modules/`)
- Dev server: `npm run dev` (`tsx watch src/index.ts`)
- Build: `npm run build` (`prisma generate && tsc`)
- Typecheck only: `npm run typecheck`
- Lint: `npm run lint`
- Test all: `npm test` (`vitest run`); a single file: `npx vitest run src/modules/<module>/__tests__/<name>.test.ts`
- Regenerate the Prisma client after a schema change, no DB connection needed: `npm run db:generate`
- Push a schema change to the Neon DB: `npm run db:push` (retries through Neon cold-starts); a
  change that needs it (e.g. a new unique constraint) requires `npx prisma db push --accept-data-loss` directly
- `src/config/env.ts` Zod-validates `DATABASE_URL`, `DIRECT_URL`, and `JWT_SECRET` (min 32 chars)
  eagerly on import — `typecheck`/`test`/`db:generate` all need these set in the environment even
  though most don't touch the database, or they fail before running anything

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

- **ESM import paths use `.js` even for `.ts` files** (`from '../../utils/ApiError.js'`). The build is
  `prisma generate && tsc`; a missing/extra extension fails the build. Match the existing imports.
- **`ApiError` style is per-file, not global.** Some controllers use the constructor
  `throw new ApiError('msg', 404)`; others use statics `ApiError.notFound('msg')`. Match whatever the
  file you're editing already uses — don't introduce the other style.
- **`vitest` covers 11 `*.test.ts` files (growing)**, all colocated in a module's `__tests__/` dir,
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
- **Prod DB is Neon** — schema changes go via `npm run db:push` (never `prisma migrate dev`); adding a
  unique constraint needs `--accept-data-loss` even when safe.
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
- **`Deal` is chain-wide, not outlet-scoped via the standard contract above** — it uses
  `outletIds: String[]` as an allow-list (empty = every outlet) instead of `resolveOutletScope`'s
  `where.outletId` shape, because it overlays the equally chain-wide `FoodMenuItem`/`FoodCategory`
  catalog. See `deal.controller.ts`'s top comment. Don't flag its missing `where.outletId` as a
  scoping leak when auditing against the outlet-scoping contract — it's a deliberate exception.
- **`FoodMenuItem.costPrice` / `FoodMenuVariant.costPrice`** (added 2026-08-22) are plain persisted
  columns, not server-computed — `menu.controller.ts`'s `createMenuItem`/`updateMenuItem` just store
  whatever the client sends (`costPrice ?? 0` on the item, `v.costPrice ?? 0` per variant) with no
  backend recipe-cost recalculation. A trustworthy snapshot depends entirely on the frontend having
  computed and sent it correctly (`FoodMenuForm.tsx`) — don't assume it's server-verified.

<!-- code-review-graph MCP tools -->
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
