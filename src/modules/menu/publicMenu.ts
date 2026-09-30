import { resolveChannelPrice } from '../deals/deal.pricing.js';

export function isVariantAvailable(
  recipes: { variantId: string | null; ingredientId: string | null; productionItemId: string | null; qtyPerUnit: unknown }[],
  variantId: string | null,
  ingredientStock: Map<string, number>,
  productionStock: Map<string, number>,
): boolean {
  const relevant = recipes.filter((r) => (variantId ? !r.variantId || r.variantId === variantId : !r.variantId));
  if (relevant.length === 0) return true;
  for (const r of relevant) {
    const qtyPerUnit = Number(r.qtyPerUnit);
    if (!qtyPerUnit || qtyPerUnit <= 0) continue;
    const stock = r.ingredientId
      ? ingredientStock.get(r.ingredientId) ?? 0
      : r.productionItemId
      ? productionStock.get(r.productionItemId) ?? 0
      : 0;
    if (Math.floor(stock / qtyPerUnit) <= 0) return false;
  }
  return true;
}

export function toPublicMenuItem(
  item: any,
  itemRecipes: any[],
  ingredientStock: Map<string, number>,
  productionStock: Map<string, number>,
  orderType?: string,
) {
  const variants = item.variants.map((v: any) => ({
    id: v.id,
    name: v.name,
    price: orderType ? resolveChannelPrice({ ...v, price: Number(v.price), dineInPrice: v.dineInPrice ? Number(v.dineInPrice) : null, takeAwayPrice: v.takeAwayPrice ? Number(v.takeAwayPrice) : null, deliveryPrice: v.deliveryPrice ? Number(v.deliveryPrice) : null, foodpandaPrice: v.foodpandaPrice ? Number(v.foodpandaPrice) : null }, orderType) : Number(v.price),
    available: isVariantAvailable(itemRecipes, v.id, ingredientStock, productionStock),
  }));

  const available = variants.length > 0
    ? variants.some((v: any) => v.available)
    : isVariantAvailable(itemRecipes, null, ingredientStock, productionStock);

  return {
    id: item.id,
    name: item.name,
    price: orderType ? resolveChannelPrice({ ...item, price: Number(item.price), dineInPrice: item.dineInPrice ? Number(item.dineInPrice) : null, takeAwayPrice: item.takeAwayPrice ? Number(item.takeAwayPrice) : null, deliveryPrice: item.deliveryPrice ? Number(item.deliveryPrice) : null, foodpandaPrice: item.foodpandaPrice ? Number(item.foodpandaPrice) : null }, orderType) : Number(item.price),
    image: item.image ?? null,
    category: item.category ? { id: item.category.id, name: item.category.name } : null,
    available,
    variants,
    modifiers: item.modifiers
      .filter((mm: any) => mm.modifier.status === 'active')
      .map((mm: any) => ({ id: mm.modifier.id, name: mm.modifier.name, price: Number(mm.modifier.price) })),
  };
}

export async function buildPublicMenu(prisma: any, options: { outletId: string | null; orderType?: string }) {
  const { outletId, orderType } = options;

  const categories = await prisma.foodCategory.findMany({
    where: { status: 'active' },
    orderBy: [{ displayOrder: 'asc' }, { name: 'asc' }],
    select: { id: true, name: true, displayOrder: true, status: true },
  });

  const items = await prisma.foodMenuItem.findMany({
    where: { available: true },
    orderBy: [{ category: { displayOrder: 'asc' } }, { name: 'asc' }],
    include: {
      category: { select: { id: true, name: true } },
      variants: { orderBy: { displayOrder: 'asc' } },
      modifiers: { include: { modifier: true } },
    },
  });

  const menuItemIds = items.map((item: any) => item.id);
  const recipes = menuItemIds.length
    ? await prisma.foodRecipe.findMany({
        where: { menuItemId: { in: menuItemIds } },
        select: { menuItemId: true, variantId: true, ingredientId: true, productionItemId: true, qtyPerUnit: true },
      })
    : [];

  const ingredientStock = new Map<string, number>();
  const productionStock = new Map<string, number>();
  if (recipes.length > 0) {
    let kitchenWarehouseId: string | null = null;
    if (outletId) {
      const kw = await prisma.warehouse.findFirst({
        where: { outletId, type: 'KITCHEN' as never, isActive: true },
        select: { id: true },
      });
      kitchenWarehouseId = kw?.id ?? null;
    }
    const ingredientIds = Array.from(new Set(recipes.map((r: any) => r.ingredientId).filter((id: any): id is string => !!id)));
    const productionItemIds = Array.from(new Set(recipes.map((r: any) => r.productionItemId).filter((id: any): id is string => !!id)));

    if (kitchenWarehouseId) {
      if (ingredientIds.length) {
        const rows = await prisma.warehouseStock.findMany({
          where: { warehouseId: kitchenWarehouseId, ingredientId: { in: ingredientIds } },
          select: { ingredientId: true, currentStock: true },
        });
        for (const r of rows) ingredientStock.set(r.ingredientId, Math.max(0, Number(r.currentStock)));
      }
      if (productionItemIds.length) {
        const rows = await prisma.productionWarehouseStock.findMany({
          where: { warehouseId: kitchenWarehouseId, productionItemId: { in: productionItemIds } },
          select: { productionItemId: true, currentStock: true },
        });
        for (const r of rows) {
          productionStock.set(r.productionItemId, (productionStock.get(r.productionItemId) ?? 0) + Math.max(0, Number(r.currentStock)));
        }
      }
    } else if (ingredientIds.length) {
      const rows = await prisma.ingredient.findMany({
        where: { id: { in: ingredientIds } },
        select: { id: true, currentStock: true },
      });
      for (const r of rows) ingredientStock.set(r.id, Math.max(0, Number(r.currentStock)));
    }
  }

  const recipesByItem = new Map<string, typeof recipes>();
  for (const r of recipes) {
    if (!recipesByItem.has(r.menuItemId)) recipesByItem.set(r.menuItemId, []);
    recipesByItem.get(r.menuItemId)!.push(r);
  }

  const publicItems = items.map((item: any) => {
    const itemRecipes = recipesByItem.get(item.id) ?? [];
    return toPublicMenuItem(item, itemRecipes, ingredientStock, productionStock, orderType);
  });

  return { categories, items: publicItems };
}
