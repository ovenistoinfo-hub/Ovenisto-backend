/**
 * Ovenisto — Menu Cost/Margin Backfill
 * Recomputes and persists FoodMenuItem.costPrice / FoodMenuVariant.costPrice for EVERY
 * menu item, mirroring exactly what saving the item in FoodMenuForm.tsx does client-side
 * (recipe qty converted to the ingredient's base unit via UnitConversion, × purchasePrice).
 *
 * Needed because items created directly via prisma/seed-menu.ts (or any other non-UI path)
 * have recipes but were never "saved" through the form, so costPrice stayed at its 0 default
 * and the Food Menu page's Cost/Margin columns showed "—".
 *
 * Safe to re-run — it's a pure recompute, no creates/deletes.
 *
 * Run with: npx tsx prisma/backfill-menu-costs.ts
 */

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  console.log('💰 Recomputing menu item cost & margin…\n');

  // ── Build unit conversion map (unitId → unitId → factor), mirroring FoodMenuForm's buildConversionMap ──
  const units = await prisma.ingredientUnit.findMany({ include: { conversionsFrom: true } });
  const conversionMap: Record<string, Record<string, number>> = {};
  for (const u of units) {
    conversionMap[u.id] = { [u.id]: 1 };
    for (const conv of u.conversionsFrom) {
      conversionMap[u.id][conv.toUnitId] = Number(conv.factor);
    }
  }
  const convertToBaseUnit = (qty: number, fromUnitId: string | null, toUnitId: string): number => {
    if (!fromUnitId || fromUnitId === toUnitId) return qty;
    const factor = conversionMap[fromUnitId]?.[toUnitId];
    return factor !== undefined ? qty * factor : qty;
  };

  // ── Ingredient purchase price + base unit lookup ──
  const ingredients = await prisma.ingredient.findMany({ select: { id: true, unitId: true, purchasePrice: true } });
  const ingMap = new Map(ingredients.map(i => [i.id, i]));

  const recipeCost = (recipe: { ingredientId: string | null; usageUnitId: string | null; qtyPerUnit: any }): number => {
    if (!recipe.ingredientId) return 0; // production-item-backed recipes have no purchasePrice to cost against
    const ing = ingMap.get(recipe.ingredientId);
    if (!ing || !ing.unitId || ing.purchasePrice == null) return 0;
    const baseQty = convertToBaseUnit(Number(recipe.qtyPerUnit), recipe.usageUnitId, ing.unitId);
    return baseQty * Number(ing.purchasePrice);
  };

  // ── Walk every menu item ──
  const items = await prisma.foodMenuItem.findMany({
    include: {
      recipes: true, // base-item recipes (variantId = null) live here too
      variants: { include: { recipes: true }, orderBy: { displayOrder: 'asc' } },
    },
  });

  let itemsUpdated = 0, variantsUpdated = 0;

  for (const item of items) {
    const baseRecipes = item.recipes.filter(r => r.variantId === null);
    const baseCost = baseRecipes.reduce((sum, r) => sum + recipeCost(r), 0);

    let variantCosts: number[] = [];
    for (const v of item.variants) {
      const vCost = v.recipes.reduce((sum, r) => sum + recipeCost(r), 0);
      variantCosts.push(vCost);
      await prisma.foodMenuVariant.update({ where: { id: v.id }, data: { costPrice: vCost } });
      variantsUpdated++;
    }

    // Matches FoodMenuForm's save: variant pricing → item.costPrice = first variant's cost; simple pricing → base recipe cost.
    const itemCostPrice = item.variants.length > 0 ? (variantCosts[0] ?? 0) : baseCost;
    await prisma.foodMenuItem.update({ where: { id: item.id }, data: { costPrice: itemCostPrice } });
    itemsUpdated++;

    const margin = Number(item.price) > 0 ? (((Number(item.price) - itemCostPrice) / Number(item.price)) * 100).toFixed(0) : '—';
    console.log(`  ✅ ${item.name}: cost Rs.${itemCostPrice.toFixed(0)} / price Rs.${Number(item.price).toFixed(0)} (${margin}% margin)`);
  }

  console.log(`\n🎉 Done — ${itemsUpdated} menu items, ${variantsUpdated} variants updated.`);
}

main()
  .catch((e) => { console.error('❌ Backfill error:', e); process.exit(1); })
  .finally(() => prisma.$disconnect());
