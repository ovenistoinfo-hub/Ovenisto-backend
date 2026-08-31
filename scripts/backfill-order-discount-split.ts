/**
 * One-off backfill for the ORDER_DISCOUNT -> PROMO_CODE / MIN_SPEND deal type split.
 *
 * A deal with a `code` set was a customer-typed Promo Code; one with no `code` was an
 * auto-applying Minimum Spend deal — that's the exact rule `resolveOrderDiscount` already
 * used to branch on. This just makes the distinction a real `type` value instead of an
 * implicit code-presence check.
 *
 * Idempotent: re-running after every ORDER_DISCOUNT row has migrated is a no-op (both
 * updateMany calls match zero rows).
 *
 * Run after `npm run db:push` has added PROMO_CODE/MIN_SPEND to the DealType enum, and
 * before the follow-up destructive push that drops ORDER_DISCOUNT from the enum.
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const before = await prisma.deal.count({ where: { type: 'ORDER_DISCOUNT' } });
  console.log(`Found ${before} deal(s) with type=ORDER_DISCOUNT.`);

  if (before === 0) {
    console.log('Nothing to backfill.');
    return;
  }

  const promoResult = await prisma.deal.updateMany({
    where: { type: 'ORDER_DISCOUNT', code: { not: null } },
    data: { type: 'PROMO_CODE' },
  });
  console.log(`Migrated ${promoResult.count} deal(s) with a code -> PROMO_CODE.`);

  const minSpendResult = await prisma.deal.updateMany({
    where: { type: 'ORDER_DISCOUNT', code: null },
    data: { type: 'MIN_SPEND' },
  });
  console.log(`Migrated ${minSpendResult.count} deal(s) with no code -> MIN_SPEND.`);

  const remaining = await prisma.deal.count({ where: { type: 'ORDER_DISCOUNT' } });
  if (remaining > 0) {
    console.warn(
      `${remaining} deal(s) still have type=ORDER_DISCOUNT after backfill — investigate before ` +
        'dropping the enum member (npx prisma db push --accept-data-loss).'
    );
  } else {
    console.log('All ORDER_DISCOUNT rows migrated. Safe to drop the enum member next.');
  }
}

main()
  .catch((error) => {
    console.error('Backfill failed:', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
