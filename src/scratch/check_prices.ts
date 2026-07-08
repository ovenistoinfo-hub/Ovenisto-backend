import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function main() {
  const ingredients = await prisma.ingredient.findMany({
    select: { id: true, name: true, purchasePrice: true }
  });
  console.log("=== INGREDIENTS ===");
  console.log(JSON.stringify(ingredients, null, 2));
  
  const stockBatches = await prisma.stockBatch.findMany({
    take: 10,
    select: { id: true, ingredientId: true, warehouseId: true, unitCost: true }
  });
  console.log("=== STOCK BATCHES ===");
  console.log(JSON.stringify(stockBatches, null, 2));
}

main().catch(console.error).finally(() => prisma.$disconnect());
