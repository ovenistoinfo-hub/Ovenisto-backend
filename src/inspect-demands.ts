import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function main() {
  const warehouses = await prisma.warehouse.findMany({
    select: { id: true, name: true, type: true, outletId: true }
  });
  console.log('--- WAREHOUSES ---');
  console.log(JSON.stringify(warehouses, null, 2));

  const demands = await prisma.stockDemand.findMany({
    include: {
      requestingWH: { select: { name: true, type: true } },
      supplyingWH: { select: { name: true, type: true } }
    }
  });
  console.log('--- DEMANDS ---');
  console.log(JSON.stringify(demands.map(d => ({
    id: d.id,
    demandNo: d.demandNo,
    status: d.status,
    requestingWHId: d.requestingWHId,
    requestingWHName: d.requestingWH?.name,
    requestingWHType: d.requestingWH?.type,
    supplyingWHId: d.supplyingWHId,
    supplyingWHName: d.supplyingWH?.name,
    supplyingWHType: d.supplyingWH?.type
  })), null, 2));
}

main().catch(console.error).finally(() => prisma.$disconnect());
