import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function testStats() {
  const mainWHId = "7420985a-9f53-4d16-adf9-c1e8f589cb60";

  const whStockFilter = { warehouseId: mainWHId };
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

  console.log(`--- All Main Warehouse Stocks (${stockItems.length} records) ---`);
  let totalVal = 0;
  for (const item of stockItems) {
    const currentStock = Number(item.currentStock) || 0;
    const unitPrice = Number(item.ingredient.purchasePrice) || 0;
    const value = currentStock * unitPrice;
    totalVal += value;
    console.log(`Item: ${item.ingredient.name} | CurrentStock: ${currentStock} | Price: ${unitPrice} | Value: ${value}`);
  }
  console.log(`Main Warehouse Total Stock Value: ${totalVal}`);

  await prisma.$disconnect();
}

testStats().catch(console.error);
