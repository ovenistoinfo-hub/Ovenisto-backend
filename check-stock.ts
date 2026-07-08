import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function checkStock() {
  const warehouses = await prisma.warehouse.findMany({
    include: {
      _count: { select: { warehouseStock: true } },
    },
  });

  console.log("=== WAREHOUSES ===");
  for (const w of warehouses) {
    console.log(`Warehouse ID: ${w.id}, Name: ${w.name}, Code: ${w.code}, Type: ${w.type}, Stock Records Count: ${w._count.warehouseStock}`);
  }

  console.log("\n=== ALL INGREDIENTS ===");
  const ingredients = await prisma.ingredient.findMany({
    select: { id: true, name: true, purchasePrice: true }
  });
  console.log(`Total Ingredients in system: ${ingredients.length}`);

  console.log("\n=== SAMPLE WAREHOUSE STOCKS ===");
  const stocks = await prisma.warehouseStock.findMany({
    take: 20,
    include: {
      warehouse: { select: { name: true, type: true } },
      ingredient: { select: { name: true, purchasePrice: true } }
    }
  });

  for (const s of stocks) {
    console.log(`WH: ${s.warehouse.name} (${s.warehouse.type}) | Ingredient: ${s.ingredient.name} | Current Stock: ${s.currentStock} | Low Level: ${s.lowStockLevel}`);
  }

  await prisma.$disconnect();
}

checkStock().catch(console.error);
