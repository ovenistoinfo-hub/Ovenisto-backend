# Dough Lifecycle — Design Spec (Spec 2)

**Date:** 2026-06-20
**Status:** Approved (pending final review)
**Scope:** Track short-shelf-life ingredients (e.g. dough, 8-hour life) end to end: produce them in the Production module (consuming other ingredients), give each production a time-stamped batch, show a live countdown on the Dashboard, deduct them FIFO when menu items sell, and let staff waste an expired batch with one click.

> This is the companion to the dashboard redesign (2026-06-19-dashboard-redesign-design.md). The dashboard's "dough batch" corner widget was deferred to this spec.

---

## Problem / goal

Dough is an ingredient with a hard ~8-hour shelf life — much shorter than the date-level expiry the warehouse batch system tracks today. The restaurant needs to: (1) make dough from kitchen-stock ingredients, (2) see at a glance on the Dashboard how much time each dough batch has left (so expired dough gets thrown out instead of used), (3) have dough consumed normally when items sell, and (4) record the waste with an audit trail. No background jobs (keep Neon CU-hrs low) — expiry is computed at read time.

## Definitions / decisions (agreed)

- **Short-life ingredient** = an `Ingredient` with `shelfLifeHours` set (dough = 8). Null = normal ingredient (unchanged behaviour). This is generic: any perishable (sauce, marinade) can be marked short-life later.
- **The 8-hour clock** = `StockBatch.createdAt` (set at production time). **Expiry = `createdAt + shelfLifeHours`, computed at read time, never stored.** No schema time-field migration, no cron.
- **Dough recipe (flour -> dough)** is NOT stored. At production time the user manually picks the consumed ingredients + quantities (flexible; records actual consumption per batch).
- **Dough recipe (pizza -> dough)** already works: `FoodRecipe` links the dough ingredient to a menu item; selling the item deducts dough like any ingredient.
- **FIFO on sale:** when a sale deducts the dough ingredient, the oldest dough `StockBatch` (smallest `createdAt`) is drawn down first — even if it's already past expiry (real-world rotation; the sale is never blocked).
- **On expiry:** a manual "Waste" button (no auto-waste / no cron). Wasting deducts the batch's remaining qty from stock and writes a `WasteRecord`.
- **Roles:** dough production + waste allowed for `['Super Admin','Admin','Manager','Store Manager','Kitchen Manager']` (the existing `stockRoles` plus Kitchen Manager).

## Architecture

### Schema change (one field)
`Ingredient` gains `shelfLifeHours Int?` (nullable). `prisma db push` — additive, no data loss. A non-null `shelfLifeHours` is the only signal needed to mark an ingredient short-life.

### Dough production (extends existing `createProduction`)
`createProduction` (`src/modules/stock/stock.controller.ts:246`) today creates a `Production` row and, if `menuItemId + deductIngredients`, decrements that menu item's recipe ingredients. Extend it with new optional body fields:
- `producedIngredientId: string` — the dough ingredient being made
- `consumedIngredients: { ingredientId: string; qty: number }[]` — what was used (flour, water, yeast)
- `warehouseId?: string` — the kitchen warehouse the batch lands in (resolve the outlet's KITCHEN warehouse if omitted)

When `producedIngredientId` is present, the existing transaction also, atomically:
1. Decrement each `consumedIngredients[i]` from `Ingredient.currentStock`.
2. Increment `producedIngredientId`'s `Ingredient.currentStock` by `quantity`.
3. Create a `StockBatch`: `ingredientId = producedIngredientId`, `batchQty = remainingQty = quantity`, `warehouseId`, `createdAt = now()`, `expiryDate = null` (expiry is derived from `shelfLifeHours`, not this column).
4. Create a `StockAdjustment` audit row for the produced dough (type `produce`).

The existing `menuItemId/deductIngredients` path is untouched and still works.

### Read API — dough batches
`GET /api/stock/dough-batches?outletId=<id|all>` (auth, dough roles): returns active short-life batches (`remainingQty > 0`, ingredient has `shelfLifeHours != null`), each:
```jsonc
{
  "id": "batch-uuid",
  "ingredientId": "dough-uuid",
  "ingredientName": "Pizza Dough",
  "unit": "kg",
  "remainingQty": 8,
  "madeAt": "2026-06-20T09:00:00.000Z",
  "expiresAt": "2026-06-20T17:00:00.000Z",      // madeAt + shelfLifeHours, computed
  "minutesRemaining": 312,                        // max(0, expiresAt - now) in minutes
  "status": "active" | "near-expiry" | "expired"  // near-expiry when <= 60 min, expired when <= 0
}
```
Sorted by `expiresAt` ascending (most urgent first). Outlet filter via the batch's warehouse `outletId`.

### Waste API
`POST /api/stock/dough-batches/:id/waste` (auth, dough roles): in a transaction —
1. Read the batch (+ ingredient for name/price/unit). If `remainingQty <= 0` -> `ApiError.badRequest('Batch already empty')`.
2. Decrement `Ingredient.currentStock` by `remainingQty`.
3. Set the batch's `remainingQty = 0`.
4. Create a `WasteRecord`: `itemName = ingredientName`, `quantity = remainingQty`, `unit`, `cost = remainingQty * purchasePrice`, `reason = 'Expired (short shelf life)'`, `recordedBy = req.user.name`.
Returns the created waste record. The existing Waste page shows it automatically.

### FIFO on sale (order completion)
`order.controller.ts` (~line 387) decrements ingredient `currentStock` for each recipe ingredient when an order completes. Extend the deduction loop: for any deducted ingredient that has `shelfLifeHours != null`, also draw the quantity down across its `StockBatch` rows in `createdAt` ascending order (oldest first), reducing each batch's `remainingQty` until the quantity is satisfied (a batch can go to 0; if batches are insufficient, the global `currentStock` still decrements — batches just floor at 0). This keeps batch `remainingQty` in sync with sales so the countdown list reflects what's actually left. Non-short-life ingredients are unaffected.

### Frontend
- **Production page** (`Production.tsx`): add a "Produce Dough / Short-Life Item" form — select the produced (short-life) ingredient, enter quantity + unit, and add consumed-ingredient rows (ingredient + qty). On submit, call `createProduction` with the new fields. The existing menu-item production path stays.
- **`stock.service.ts`**: add `getDoughBatches({outletId?})` and `wasteDoughBatch(id)`.
- **Dashboard**: a "Dough / Short-Life Batches" card. Uses `useVisiblePolling` (existing) to refetch every 30s, plus a client-side 1-minute `setInterval` tick to recompute `minutesRemaining` live without network calls. Each row: ingredient name + remaining qty + "Xh Ym left", colour-coded green / orange (<=1h) / red (expired). Expired rows show a "Waste" button (confirm dialog) calling `wasteDoughBatch`. Empty -> "No active dough batches". Respects the Dashboard outlet switcher.

## Error handling

- Production with `consumedIngredients` that exceed stock: the current system allows deductions to go negative; keep that consistent (don't block), and the audit `StockAdjustment` records it.
- Waste on an already-empty / re-clicked batch -> `400 Batch already empty` (idempotent-safe).
- All Decimal -> `Number()`. Expiry math in UTC; UI formats local.
- Empty results -> empty array (no crash).

## Testing

Backend (vitest, already set up). Pure helpers, unit-tested:
- `computeExpiry(createdAt, shelfLifeHours) -> Date`
- `batchStatus(expiresAt, now) -> 'active'|'near-expiry'|'expired'` (boundary: exactly 60 min, exactly 0).
- `minutesRemaining(expiresAt, now) -> number` (floors at 0).
- `fifoDrawdown(batches, qty) -> {batchId, newRemaining}[]` — oldest first, handles insufficient batches.
Endpoint wiring verified manually against the live DB (like the reports endpoints).

## Out of scope (explicit)

- Auto-waste / cron expiry (deliberately avoided — CU-hr cost).
- A formal "ingredient recipe" system (flour->dough fixed recipe) — consumption is manual per batch in v1.
- Outlet-scoping of dough waste cost in any restaurant-wide report (waste records are global, matching the existing Waste page).
- Changing `StockBatch.expiryDate` to a datetime — not needed; expiry is derived.
- Per-batch barcode/label printing.
