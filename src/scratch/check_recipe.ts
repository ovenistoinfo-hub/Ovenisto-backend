import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function main() {
  const item = await prisma.foodMenuItem.findFirst({
    where: { name: { contains: "Cheese Trio Pizza", mode: "insensitive" } },
    include: {
      recipes: {
        include: {
          ingredient: true,
          productionItem: true
        }
      }
    }
  });
  console.log("=== FOOD ITEM & RECIPE ===");
  console.log(JSON.stringify(item, null, 2));
}

main().catch(console.error).finally(() => prisma.$disconnect());
