import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  console.log('🧹 Starting deletion of all active (PENDING, PREPARING, READY) orders...\n');

  // 1. Find all active orders
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
      tableNumber: true,
    },
  });

  if (activeOrders.length === 0) {
    console.log('✨ No active pending or ready orders found in database.');
    return;
  }

  console.log(`Found ${activeOrders.length} active order(s) to delete:`);
  for (const ord of activeOrders) {
    console.log(`  - ID: ${ord.id} | #${ord.orderNumber} | Status: ${ord.status}`);
  }

  const activeOrderIds = activeOrders.map((o) => o.id);

  // 2. Delete linked child records explicitly if not set to cascade
  const delAssignments = await prisma.deliveryAssignment.deleteMany({
    where: { orderId: { in: activeOrderIds } },
  });
  console.log(`✅ Deleted ${delAssignments.count} linked delivery assignments`);

  const delLoyalty = await prisma.loyaltyTransaction.deleteMany({
    where: { orderId: { in: activeOrderIds } },
  });
  console.log(`✅ Deleted ${delLoyalty.count} linked loyalty transactions`);

  // 3. Delete the active orders (cascade deletes OrderItem, OrderKitchenProgress, OrderModificationLog, OrderCancellationRequest, WasteRecord)
  const delOrders = await prisma.order.deleteMany({
    where: { id: { in: activeOrderIds } },
  });
  console.log(`✅ Deleted ${delOrders.count} active order(s)`);

  // 4. Reset table statuses for tables linked to deleted active orders
  const tablesToReset = await prisma.restaurantTable.findMany({
    where: {
      OR: [
        { currentOrderId: { in: activeOrderIds } },
        { status: { in: ['occupied', 'bill-requested'] } },
      ],
    },
  });

  if (tablesToReset.length > 0) {
    const updatedTables = await prisma.restaurantTable.updateMany({
      where: {
        id: { in: tablesToReset.map((t) => t.id) },
      },
      data: {
        currentOrderId: null,
        status: 'available',
        occupiedById: null,
        occupiedByName: null,
        occupiedByRole: null,
      },
    });
    console.log(`✅ Reset ${updatedTables.count} table(s) to 'available'`);
  }

  console.log('\n🎉 Successfully removed all pending and ready orders!');
}

main()
  .catch((e) => {
    console.error('❌ Error deleting active orders:', e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
