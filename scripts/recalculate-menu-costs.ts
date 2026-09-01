import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function recalculateMenuCosts() {
  console.log('🔄 Calculating recipe food costs for all menu items & variants...\n');

  const items = await prisma.foodMenuItem.findMany({
    include: {
      recipes: {
        include: {
          ingredient: {
            include: { unit: true },
          },
          usageUnit: true,
        },
      },
      variants: {
        include: {
          recipes: {
            include: {
              ingredient: {
                include: { unit: true },
              },
              usageUnit: true,
            },
          },
        },
      },
    },
  });

  for (const item of items) {
    let itemBaseCost = 0;

    // Calculate base item recipe cost
    for (const r of item.recipes) {
      if (r.ingredient?.purchasePrice != null) {
        const qty = Number(r.qtyPerUnit || 0);
        const price = Number(r.ingredient.purchasePrice || 0);
        itemBaseCost += qty * price;
      }
    }

    // Update item costPrice if calculated or default
    const finalItemCost = Math.round(itemBaseCost);
    await prisma.foodMenuItem.update({
      where: { id: item.id },
      data: { costPrice: finalItemCost > 0 ? finalItemCost : Number(item.costPrice || 0) },
    });

    console.log(`🍕 ${item.name} (${item.code}):`);
    console.log(`   Selling Price: Rs. ${Number(item.price)} | Food Cost: Rs. ${finalItemCost}`);

    // Update variants
    for (const v of item.variants) {
      let variantCost = 0;
      if (v.recipes && v.recipes.length > 0) {
        for (const r of v.recipes) {
          if (r.ingredient?.purchasePrice != null) {
            const qty = Number(r.qtyPerUnit || 0);
            const price = Number(r.ingredient.purchasePrice || 0);
            variantCost += qty * price;
          }
        }
      } else if (finalItemCost > 0) {
        // If variant doesn't have its own recipe rows, scale proportionally to selling price
        const ratio = Number(item.price) > 0 ? Number(v.price) / Number(item.price) : 1;
        variantCost = Math.round(finalItemCost * ratio);
      }

      const finalVariantCost = Math.round(variantCost);
      await prisma.foodMenuVariant.update({
        where: { id: v.id },
        data: { costPrice: finalVariantCost },
      });

      console.log(`   └─ Variant: ${v.name} -> Price: Rs. ${Number(v.price)} | Cost: Rs. ${finalVariantCost}`);
    }
  }

  console.log('\n✅ All menu item and variant cost prices successfully updated in database!');
}

recalculateMenuCosts()
  .catch((e) => {
    console.error('Error recalculating menu costs:', e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
