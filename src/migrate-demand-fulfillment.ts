import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function main() {
  console.log('--- STARTING DEMAND FULFILLMENT MIGRATION ---');

  // Find all approved demands that have a received challan
  const demandsToUpdate = await prisma.stockDemand.findMany({
    where: {
      status: 'APPROVED',
      challanId: { not: null },
      challan: {
        status: 'RECEIVED'
      }
    },
    include: {
      challan: {
        select: {
          receivedAt: true,
          challanNo: true
        }
      }
    }
  });

  console.log(`Found ${demandsToUpdate.length} approved demands with received challans.`);

  let updatedCount = 0;
  for (const demand of demandsToUpdate) {
    const fulfilledAt = demand.challan?.receivedAt || new Date();
    await prisma.stockDemand.update({
      where: { id: demand.id },
      data: {
        status: 'FULFILLED',
        fulfilledAt
      }
    });
    console.log(`Updated demand ${demand.demandNo} (linked to received challan ${demand.challan?.challanNo}) to FULFILLED.`);
    updatedCount++;
  }

  console.log(`--- MIGRATION COMPLETED: ${updatedCount} demands updated ---`);
}

main()
  .catch((err) => {
    console.error('Migration failed:', err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
