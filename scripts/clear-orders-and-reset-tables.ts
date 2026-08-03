import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  console.log('🧹 Clearing all order history and resetting tables...');

  try {
    // 1. Delivery assignments
    const deletedAssignments = await prisma.deliveryAssignment.deleteMany({});
    console.log(`- Deleted ${deletedAssignments.count} delivery assignments.`);

    // 2. Order cancellation requests
    const deletedCancelRequests = await prisma.orderCancellationRequest.deleteMany({});
    console.log(`- Deleted ${deletedCancelRequests.count} order cancellation requests.`);

    // 3. Order modification logs
    const deletedModifications = await prisma.orderModificationLog.deleteMany({});
    console.log(`- Deleted ${deletedModifications.count} order modification logs.`);

    // 4. Waste records tied to orders
    const deletedOrderWaste = await prisma.wasteRecord.deleteMany({
      where: { NOT: { orderId: null } },
    });
    console.log(`- Deleted ${deletedOrderWaste.count} order-linked waste records.`);

    // 5. Order items
    const deletedItems = await prisma.orderItem.deleteMany({});
    console.log(`- Deleted ${deletedItems.count} order items.`);

    // 6. Orders
    const deletedOrders = await prisma.order.deleteMany({});
    console.log(`- Deleted ${deletedOrders.count} orders.`);

    // 7. Reset Restaurant Tables
    const resetTables = await prisma.restaurantTable.updateMany({
      data: {
        status: 'available',
        currentOrderId: null,
      },
    });
    console.log(`- Reset ${resetTables.count} tables to AVAILABLE with empty session.`);

    console.log('✅ Order history cleared and tables reset successfully!');
  } catch (error) {
    console.error('❌ Failed to clear order data:', error);
  } finally {
    await prisma.$disconnect();
  }
}

main();
