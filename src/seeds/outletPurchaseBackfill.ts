/**
 * One-time, idempotent backfill of outletId on Purchase (Phase B4a).
 * Only touches rows where outletId IS NULL.
 *   - derive from the row's warehouse.outletId where warehouseId is set and the warehouse has an outlet;
 *   - otherwise (no warehouse, or a central MAIN/null-outlet warehouse) → "Ovenisto Main Branch".
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

  const purchases = await prisma.purchase.findMany({
    where: { outletId: null },
    select: { id: true, warehouse: { select: { outletId: true } } },
  });
  let derived = 0, fellBack = 0;
  for (const p of purchases) {
    const outletId = p.warehouse?.outletId ?? fallback;
    if (p.warehouse?.outletId) derived++; else fellBack++;
    await prisma.purchase.update({ where: { id: p.id }, data: { outletId } });
  }

  const stillNull = await prisma.purchase.count({ where: { outletId: null } });

  console.log('[outletPurchaseBackfill] done:', { purchases: { derived, fallback: fellBack }, stillNull });

  if (stillNull > 0) {
    throw new Error(`Backfill incomplete: ${stillNull} purchases still have a null outletId.`);
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => { console.error(e); process.exit(1); });
