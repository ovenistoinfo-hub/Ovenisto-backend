/**
 * One-time, idempotent backfill of outletId on stock rows (Phase B1).
 * Only touches rows where outletId IS NULL.
 *   - StockAdjustment / StockTake: derive from the row's warehouse.outletId when present;
 *     otherwise (no warehouse, or a warehouse with a null outlet) → "Ovenisto Main Branch".
 *   - Production / WasteRecord: no warehouse link → "Ovenisto Main Branch".
 * Safe to re-run.
 */
import { prisma } from '../config/database.js';

const MAIN_BRANCH_NAME = 'Ovenisto Main Branch';

async function main() {
  const mainBranch = await prisma.outlet.findFirst({
    where: { name: MAIN_BRANCH_NAME },
    select: { id: true },
  });
  if (!mainBranch) {
    throw new Error(`Backfill aborted: outlet "${MAIN_BRANCH_NAME}" not found.`);
  }
  const fallback = mainBranch.id;

  // 1. StockAdjustment — derive from warehouse outlet where possible.
  const adjustments = await prisma.stockAdjustment.findMany({
    where: { outletId: null },
    select: { id: true, warehouse: { select: { outletId: true } } },
  });
  let adjDerived = 0, adjFallback = 0;
  for (const a of adjustments) {
    const outletId = a.warehouse?.outletId ?? fallback;
    if (a.warehouse?.outletId) adjDerived++; else adjFallback++;
    await prisma.stockAdjustment.update({ where: { id: a.id }, data: { outletId } });
  }

  // 2. StockTake — same rule.
  const takes = await prisma.stockTake.findMany({
    where: { outletId: null },
    select: { id: true, warehouse: { select: { outletId: true } } },
  });
  let takeDerived = 0, takeFallback = 0;
  for (const t of takes) {
    const outletId = t.warehouse?.outletId ?? fallback;
    if (t.warehouse?.outletId) takeDerived++; else takeFallback++;
    await prisma.stockTake.update({ where: { id: t.id }, data: { outletId } });
  }

  // 3. Production — all NULL → fallback.
  const prodRes = await prisma.production.updateMany({
    where: { outletId: null },
    data: { outletId: fallback },
  });

  // 4. WasteRecord — all NULL → fallback.
  const wasteRes = await prisma.wasteRecord.updateMany({
    where: { outletId: null },
    data: { outletId: fallback },
  });

  // 5. Report + verify nothing left NULL.
  const stillNull = {
    adjustments: await prisma.stockAdjustment.count({ where: { outletId: null } }),
    takes: await prisma.stockTake.count({ where: { outletId: null } }),
    productions: await prisma.production.count({ where: { outletId: null } }),
    waste: await prisma.wasteRecord.count({ where: { outletId: null } }),
  };

  console.log('[outletStockBackfill] done:', {
    adjustments: { derived: adjDerived, fallback: adjFallback },
    takes: { derived: takeDerived, fallback: takeFallback },
    productions: prodRes.count,
    waste: wasteRes.count,
    stillNull,
  });

  const remaining = Object.values(stillNull).reduce((s, n) => s + n, 0);
  if (remaining > 0) {
    throw new Error(`Backfill incomplete: ${remaining} rows still have a null outletId.`);
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => { console.error(e); process.exit(1); });
