import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function testEndpoint() {
  const warehouseId = "7420985a-9f53-4d16-adf9-c1e8f589cb60"; // Main Warehouse ID
  const dateFilter: any = {};
  const whStockFilter = warehouseId && warehouseId !== 'all' ? { warehouseId: String(warehouseId) } : {};

  // Calculate total stock value (Inventory Value = sum of currentStock * purchasePrice)
  const stockItems = await prisma.warehouseStock.findMany({
    where: whStockFilter,
    include: {
      ingredient: {
        select: {
          id: true,
          name: true,
          purchasePrice: true,
          lowStockLevel: true,
          category: { select: { name: true } },
          supplier: { select: { name: true } }
        }
      }
    }
  });

  console.log("Total stock items returned:", stockItems.length);

  let totalInventoryValue = 0;
  const stockCostingTable = stockItems.map(item => {
    const currentStock = Number(item.currentStock) || 0;
    const lowStockLevel = Number(item.lowStockLevel) || Number(item.ingredient.lowStockLevel) || 0;
    const unitPrice = Number(item.ingredient.purchasePrice) || 0;
    const totalVal = currentStock * unitPrice;
    totalInventoryValue += totalVal;

    return {
      ingredientId: item.ingredient.id,
      name: item.ingredient.name,
      category: item.ingredient.category?.name || '—',
      currentStock,
      lowStockLevel,
      unitPrice,
      totalValue: totalVal,
      vendorName: item.ingredient.supplier?.name || '—'
    };
  });

  console.log("Calculated totalInventoryValue:", totalInventoryValue);
  console.log("Sample costing table entry:", stockCostingTable[0]);

  await prisma.$disconnect();
}

testEndpoint().catch(console.error);
