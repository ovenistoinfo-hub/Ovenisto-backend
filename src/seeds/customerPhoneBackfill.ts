/**
 * One-time backfill: normalizes every Customer.phone value to digits-only,
 * matching the write-side normalization now applied in customer.controller.ts
 * and self-order.controller.ts. Run in dry-run mode (default) first — it only
 * reports what WOULD change. Pass --apply to actually write.
 *
 * Usage:
 *   npx tsx src/seeds/customerPhoneBackfill.ts            # dry-run (default)
 *   npx tsx src/seeds/customerPhoneBackfill.ts --apply     # actually writes
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const apply = process.argv.includes('--apply');
  const customers = await prisma.customer.findMany({
    select: { id: true, name: true, phone: true },
  });

  const changes: { id: string; name: string; before: string; after: string }[] = [];
  for (const c of customers) {
    if (!c.phone) continue;
    const cleaned = c.phone.replace(/\D/g, '');
    if (cleaned && cleaned !== c.phone) {
      changes.push({ id: c.id, name: c.name, before: c.phone, after: cleaned });
    }
  }

  console.log(`Total customers: ${customers.length}`);
  console.log(`Rows that would change: ${changes.length}`);
  console.log('Sample (first 10):');
  for (const ch of changes.slice(0, 10)) {
    console.log(`  ${ch.name} (${ch.id}): "${ch.before}" -> "${ch.after}"`);
  }

  if (!apply) {
    console.log('\nDRY RUN ONLY — no changes written. Re-run with --apply to write.');
    return;
  }

  console.log('\nAPPLYING changes...');
  let updated = 0;
  for (const ch of changes) {
    await prisma.customer.update({ where: { id: ch.id }, data: { phone: ch.after } });
    updated++;
  }
  console.log(`Done. Updated ${updated} rows.`);
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
