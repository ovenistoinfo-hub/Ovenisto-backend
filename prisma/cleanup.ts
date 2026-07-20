import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  console.log('🧹 Starting data cleanup...\n');

  // Order matters — delete child tables first to avoid FK constraint errors

  const results: Record<string, number> = {};

  // 1. Purchase payments (child of Purchase & Supplier)
  results.purchasePayments = await prisma.purchasePayment.deleteMany({});
  console.log(`✅ PurchasePayment: ${results.purchasePayments.count} deleted`);

  // 2. Purchase request items (child of PurchaseRequest)
  results.purchaseRequestItems = await prisma.purchaseRequestItem.deleteMany({});
  console.log(`✅ PurchaseRequestItem: ${results.purchaseRequestItems.count} deleted`);

  // 3. Purchase requests
  results.purchaseRequests = await prisma.purchaseRequest.deleteMany({});
  console.log(`✅ PurchaseRequest: ${results.purchaseRequests.count} deleted`);

  // 4. Purchases (parent of PurchasePayment — already cleared)
  results.purchases = await prisma.purchase.deleteMany({});
  console.log(`✅ Purchase: ${results.purchases.count} deleted`);

  // 5. Suppliers (after purchases cleared)
  results.suppliers = await prisma.supplier.deleteMany({});
  console.log(`✅ Supplier: ${results.suppliers.count} deleted`);

  // 6. Stock Demand Items (child of StockDemand)
  results.stockDemandItems = await prisma.stockDemandItem.deleteMany({});
  console.log(`✅ StockDemandItem: ${results.stockDemandItems.count} deleted`);

  // 7. Stock Demands (Demand Lists)
  results.stockDemands = await prisma.stockDemand.deleteMany({});
  console.log(`✅ StockDemand: ${results.stockDemands.count} deleted`);

  // 8. Stock Challan Items (child of StockChallan)
  results.stockChallanItems = await prisma.stockChallanItem.deleteMany({});
  console.log(`✅ StockChallanItem: ${results.stockChallanItems.count} deleted`);

  // 9. Stock Challans (Transfers)
  results.stockChallans = await prisma.stockChallan.deleteMany({});
  console.log(`✅ StockChallan: ${results.stockChallans.count} deleted`);

  // 10. Transfers
  results.transfers = await prisma.transfer.deleteMany({});
  console.log(`✅ Transfer: ${results.transfers.count} deleted`);

  // 11. Warehouse Settlements
  results.warehouseSettlements = await prisma.warehouseSettlement.deleteMany({});
  console.log(`✅ WarehouseSettlement: ${results.warehouseSettlements.count} deleted`);

  // 12. Production Warehouse Stock
  results.productionWarehouseStock = await prisma.productionWarehouseStock.deleteMany({});
  console.log(`✅ ProductionWarehouseStock: ${results.productionWarehouseStock.count} deleted`);

  // 13. Stock Batches
  results.stockBatches = await prisma.stockBatch.deleteMany({});
  console.log(`✅ StockBatch: ${results.stockBatches.count} deleted`);

  // 14. Warehouse Stock
  results.warehouseStock = await prisma.warehouseStock.deleteMany({});
  console.log(`✅ WarehouseStock: ${results.warehouseStock.count} deleted`);

  // 15. Stock Adjustments
  results.stockAdjustments = await prisma.stockAdjustment.deleteMany({});
  console.log(`✅ StockAdjustment: ${results.stockAdjustments.count} deleted`);

  // 16. Reset currentStock & purchasePrice on all ingredients to 0
  const ingredientReset = await prisma.ingredient.updateMany({
    data: { currentStock: 0, purchasePrice: 0 },
  });
  console.log(`✅ Ingredient stock reset: ${ingredientReset.count} records`);

  // 17. Reset supplier totals (totalPurchases / totalDue) to 0
  // (Supplier rows were deleted, so nothing to reset — already done above)

  console.log('\n🎉 Cleanup complete!\n');
  console.log('Summary:');
  for (const [key, val] of Object.entries(results)) {
    const count = typeof val === 'object' ? (val as any).count : val;
    console.log(`  ${key}: ${count} rows deleted`);
  }
}

main()
  .catch((e) => {
    console.error('❌ Error during cleanup:', e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
