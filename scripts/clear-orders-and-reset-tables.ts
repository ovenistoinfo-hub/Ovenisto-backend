import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  console.log('🧹 Clearing all order history, shifts, and resetting tables...');

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

    // 4. Staff penalties linked to orders
    const deletedPenalties = await prisma.staffPenalty.deleteMany({
      where: { NOT: { orderId: null } },
    });
    console.log(`- Deleted ${deletedPenalties.count} staff penalties linked to orders.`);

    // 5. Loyalty transactions linked to orders
    const deletedLoyalty = await prisma.loyaltyTransaction.deleteMany({
      where: { NOT: { orderId: null } },
    });
    console.log(`- Deleted ${deletedLoyalty.count} loyalty transactions.`);

    // 6. Waste records tied to orders
    const deletedOrderWaste = await prisma.wasteRecord.deleteMany({
      where: { NOT: { orderId: null } },
    });
    console.log(`- Deleted ${deletedOrderWaste.count} order-linked waste records.`);

    // 7. Order items
    const deletedItems = await prisma.orderItem.deleteMany({});
    console.log(`- Deleted ${deletedItems.count} order items.`);

    // 8. Orders
    const deletedOrders = await prisma.order.deleteMany({});
    console.log(`- Deleted ${deletedOrders.count} orders.`);

    // 9. Shifts / Cash Registers (Clear test shifts to reset register totals)
    const deletedShifts = await prisma.shift.deleteMany({});
    console.log(`- Deleted ${deletedShifts.count} cash register shifts.`);

    // 10. Reset Reservations order references
    const resetReservations = await prisma.reservation.updateMany({
      data: {
        orderId: null,
        isAdvanceAdjusted: false,
      },
    });
    console.log(`- Reset ${resetReservations.count} reservations.`);

    // 11. Reset Restaurant Tables fully
    const resetTables = await prisma.restaurantTable.updateMany({
      data: {
        status: 'available',
        currentOrderId: null,
        occupiedById: null,
        occupiedByName: null,
        occupiedByRole: null,
        reservationId: null,
      },
    });
    console.log(`- Reset ${resetTables.count} tables to AVAILABLE with empty session.`);

    console.log('\n🎉 Order history cleared and tables reset successfully!');
  } catch (error) {
    console.error('❌ Failed to clear order data:', error);
  } finally {
    await prisma.$disconnect();
  }
}

main();

