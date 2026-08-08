import { prisma } from "../config/database.js";

async function clearOrdersAndShifts() {
  console.log("🧹 Clearing orders, shifts, and cash settlements from DB...");

  // 1. Delete dependent child records
  await prisma.orderModificationLog.deleteMany({});
  await prisma.orderCancellationRequest.deleteMany({});
  await prisma.orderKitchenProgress.deleteMany({});
  await prisma.deliveryAssignment.deleteMany({});
  await prisma.loyaltyTransaction.deleteMany({});
  await prisma.staffPenalty.deleteMany({});
  await prisma.orderItem.deleteMany({});

  // 2. Clear settlement links
  await prisma.order.updateMany({ data: { settlementId: null } });

  // 3. Delete Orders
  const deletedOrders = await prisma.order.deleteMany({});
  console.log(`✅ Deleted ${deletedOrders.count} orders`);

  // 4. Delete Cash Settlements
  const deletedSettlements = await prisma.cashSettlement.deleteMany({});
  console.log(`✅ Deleted ${deletedSettlements.count} cash settlements`);

  // 5. Delete Register Shifts
  const deletedShifts = await prisma.shift.deleteMany({});
  console.log(`✅ Deleted ${deletedShifts.count} shifts`);

  console.log("🎉 Database cleared successfully!");
  process.exit(0);
}

clearOrdersAndShifts().catch((err) => {
  console.error("❌ Error clearing database:", err);
  process.exit(1);
});
