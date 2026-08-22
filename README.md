# Ovenisto Backend

Backend API for the Ovenisto POS System.

## Documentation

- [`CLAUDE.md`](./CLAUDE.md) — backend-specific dev quick-reference (ESM import
  conventions, `ApiError` usage, the `vitest` unit-test pattern, outlet scoping
  contract, Prisma/Decimal/enum handling, self-order matcher rules, etc.).
  It also carries the architecture overview — request path, roles, the Outlet
  Scoping access-control model, real-time, environment and deployment — which
  previously lived in a workspace-level `../CLAUDE.md` outside both git repos
  and so never survived a fresh clone.
- The client is `Ovenisto_Frontend_Software`; its own `CLAUDE.md` documents the
  browser side of the same outlet-scoping model.
