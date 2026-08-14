import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const counts = await prisma.order.groupBy({
    by: ['status'],
    _count: { id: true },
  });
  console.log('Order Counts by Status:');
  console.dir(counts, { depth: null });

  const activeOrders = await prisma.order.findMany({
    where: {
      status: {
        in: ['PENDING', 'PREPARING', 'READY'],
      },
    },
    select: {
      id: true,
      orderNumber: true,
      status: true,
      type: true,
      customerName: true,
      total: true,
      createdAt: true,
    },
  });

  console.log(`Total active (PENDING/PREPARING/READY) orders: ${activeOrders.length}`);
  console.dir(activeOrders, { depth: null });
}

main()
  .catch((e) => console.error(e))
  .finally(() => prisma.$disconnect());
