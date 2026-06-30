/**
 * Employee Backfill Seed Script
 * Creates an Employee row (linked via userId) for every existing User that has
 * a non-null hourlyRate, before those columns are dropped from User.
 */
import { prisma } from '../config/database.js';

async function main() {
  console.log('👤 Starting employee backfill...');

  const users = await prisma.user.findMany({
    where: { hourlyRate: { not: null } },
  });

  let created = 0;
  let skipped = 0;

  for (const user of users) {
    const existing = await prisma.employee.findUnique({ where: { userId: user.id } });
    if (existing) {
      console.log(`✓ ${user.name} already has an Employee record, skipping`);
      skipped++;
      continue;
    }

    const [firstName, ...rest] = user.name.split(' ');
    await prisma.employee.create({
      data: {
        userId: user.id,
        outletId: user.outletId,
        firstName: firstName || user.name,
        lastName: rest.length ? rest.join(' ') : null,
        email: user.email,
        phone: user.phone || 'N/A',
        designation: user.role,
        hireDate: user.createdAt,
        rateType: 'Hourly',
        rate: user.hourlyRate!,
        penaltyFee: user.absencePenalty,
        status: user.status === 'active' ? 'active' : 'inactive',
      },
    });
    console.log(`✓ Created Employee record for ${user.name}`);
    created++;
  }

  console.log(`\n✅ Backfill complete! Created ${created}, skipped ${skipped} (already existed).`);
}

main()
  .catch((e) => {
    console.error('❌ Backfill failed:', e.message);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
