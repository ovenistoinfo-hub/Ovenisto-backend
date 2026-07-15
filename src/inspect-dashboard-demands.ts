import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function main() {
  const warehouses = await prisma.warehouse.findMany({
    where: { outletId: '9f4efa80-7b74-488d-b8dc-cdaf8888d03e' },
    select: { id: true, name: true, type: true }
  });
  console.log('--- WAREHOUSES of Main Branch Outlet ---');
  console.log(JSON.stringify(warehouses, null, 2));

  // Let's check demands in the DB for both:
  // 1. Ovenisto Main Branch Kitchen
  // 2. Ovenisto Main Branch Store
  for (const wh of warehouses) {
    const demandScope = {
      requestingWH: { type: 'BRANCH' },
      supplyingWH: { type: 'MAIN' }
    };
    const demandWhere: any = {
      ...demandScope,
      OR: [
        { supplyingWHId: wh.id },
        { requestingWHId: wh.id }
      ]
    };
    const count = await prisma.stockDemand.count({ where: demandWhere });
    console.log(`Demand count for Super Admin with selected warehouse ${wh.name} (${wh.type}):`, count);
  }
}

main().catch(console.error).finally(() => prisma.$disconnect());
