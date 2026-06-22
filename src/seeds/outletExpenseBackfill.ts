/**
 * One-time, idempotent backfill of outletId on Expense (Phase B3).
 * Only touches rows where outletId IS NULL. Expense has no derivable outlet link
 * (recordedBy is a free-text name, not a userId), so all NULL rows → "Ovenisto Main Branch".
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

  const res = await prisma.expense.updateMany({
    where: { outletId: null },
    data: { outletId: fallback },
  });

  const stillNull = await prisma.expense.count({ where: { outletId: null } });

  console.log('[outletExpenseBackfill] done:', { expenses: res.count, stillNull });

  if (stillNull > 0) {
    throw new Error(`Backfill incomplete: ${stillNull} expenses still have a null outletId.`);
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => { console.error(e); process.exit(1); });
