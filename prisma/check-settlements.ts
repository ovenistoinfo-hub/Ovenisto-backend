import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const settlements = await prisma.cashSettlement.findMany({
    take: 10,
    orderBy: { createdAt: 'desc' },
    select: {
      id: true,
      settlementNo: true,
      staffId: true,
      staffName: true,
      staffRole: true,
      totalActual: true,
      settledByName: true,
      createdAt: true,
    },
  });

  console.log('CASH SETTLEMENTS RECORD COUNT:', settlements.length);
  console.dir(settlements, { depth: null });
}

main()
  .catch((e) => console.error(e))
  .finally(() => prisma.$disconnect());
