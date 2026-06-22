/**
 * One-time, idempotent backfill of outletId on Shift and RestaurantTable (Phase B2).
 * Only touches rows where outletId IS NULL.
 *   - Shift: derive from the shift's cashier (user.outletId); cashier null / no outlet → "Ovenisto Main Branch".
 *   - RestaurantTable: no derivable link → "Ovenisto Main Branch".
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

  // 1. Shift — derive from the cashier's outlet where possible.
  const shifts = await prisma.shift.findMany({
    where: { outletId: null },
    select: { id: true, cashier: { select: { outletId: true } } },
  });
  let shiftDerived = 0, shiftFallback = 0;
  for (const s of shifts) {
    const outletId = s.cashier?.outletId ?? fallback;
    if (s.cashier?.outletId) shiftDerived++; else shiftFallback++;
    await prisma.shift.update({ where: { id: s.id }, data: { outletId } });
  }

  // 2. RestaurantTable — all NULL → fallback.
  const tableRes = await prisma.restaurantTable.updateMany({
    where: { outletId: null },
    data: { outletId: fallback },
  });

  // 3. Report + verify nothing left NULL.
  const stillNull = {
    shifts: await prisma.shift.count({ where: { outletId: null } }),
    tables: await prisma.restaurantTable.count({ where: { outletId: null } }),
  };

  console.log('[outletShiftTableBackfill] done:', {
    shifts: { derived: shiftDerived, fallback: shiftFallback },
    tables: tableRes.count,
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
