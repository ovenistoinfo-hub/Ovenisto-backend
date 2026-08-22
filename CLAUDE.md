# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

> The repo-root `../CLAUDE.md` holds the full project guide (architecture, module map,
> roles, env vars, deployment gotchas, the Outlet Scoping access-control model). It loads
> alongside this file in backend sessions — read it first. Below are only the gotchas
> specific to editing this backend that are easy to trip on.

## Git Commit Convention

- **Never mention "Claude" or any AI/model identifier in git commits, PR titles, or PR bodies** —
  no `Co-Authored-By: Claude ...` trailer, no session links. Write plain, descriptive commit
  messages only, as if written by the human developer.

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
