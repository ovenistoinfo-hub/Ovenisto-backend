import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function cleanTestDeals() {
  console.log('🧹 Cleaning dummy/test deals from database...');

  const deleted = await prisma.deal.deleteMany({
    where: {
      OR: [
        { name: { contains: 'test', mode: 'insensitive' } },
        { name: { contains: 'test12', mode: 'insensitive' } },
      ],
    },
  });

  console.log(`✅ Deleted ${deleted.count} test deals.`);

  const remaining = await prisma.deal.findMany({
    select: { id: true, name: true, type: true, price: true, isActive: true },
  });

  console.log('\n📋 Active Production Deals:');
  for (const d of remaining) {
    console.log(`  - ${d.name} (${d.type}) -> Rs. ${Number(d.price)}`);
  }
}

cleanTestDeals()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
