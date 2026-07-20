/**
 * Ovenisto — Menu Seed Script
 * Seeds food categories, menu items, variants, modifiers, ingredients & food recipes.
 *
 * Safe to run on an already-seeded DB — uses upsert / skip-if-exists patterns.
 *
 * Run with:  npx ts-node --project tsconfig.json prisma/seed-menu.ts
 * Or:        node -e "require('./dist/prisma/seed-menu.js').main()"
 */

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

// ─── helpers ──────────────────────────────────────────────────────────────────

const dec = (n: number) => n; // Prisma accepts plain numbers for Decimal fields

async function main() {
  console.log('🍕 Seeding Ovenisto menu data…\n');

  // ══════════════════════════════════════════════════════════════════════════
  // 1. Food Categories
  // ══════════════════════════════════════════════════════════════════════════

  const categoryDefs = [
    { name: 'Pizza',       displayOrder: 1 },
    { name: 'Burgers',     displayOrder: 2 },
    { name: 'Deals',       displayOrder: 3 },
    { name: 'Pasta',       displayOrder: 4 },
    { name: 'Shawarma',    displayOrder: 5 },
    { name: 'Appetizers',  displayOrder: 6 },
    { name: 'Beverages',   displayOrder: 7 },
    { name: 'Desserts',    displayOrder: 8 },
  ];

  const catMap = new Map<string, string>(); // name → id
  for (const c of categoryDefs) {
    const existing = await prisma.foodCategory.findFirst({ where: { name: c.name } });
    const cat = existing ?? await prisma.foodCategory.create({ data: c });
    catMap.set(c.name, cat.id);
    console.log(`  ✅ Category: ${c.name}`);
  }

  // ══════════════════════════════════════════════════════════════════════════
  // 2. Ingredient Units (reuse existing, create if missing)
  // ══════════════════════════════════════════════════════════════════════════

  const unitDefs = [
    { name: 'Gram',      symbol: 'g'   },
    { name: 'Kilogram',  symbol: 'kg'  },
    { name: 'Milliliter',symbol: 'ml'  },
    { name: 'Liter',     symbol: 'L'   },
    { name: 'Piece',     symbol: 'pcs' },
    { name: 'Tablespoon',symbol: 'tbsp'},
    { name: 'Teaspoon',  symbol: 'tsp' },
  ];

  const unitMap = new Map<string, string>(); // symbol → id
  for (const u of unitDefs) {
    const existing = await prisma.ingredientUnit.findFirst({ where: { symbol: u.symbol } });
    const unit = existing ?? await prisma.ingredientUnit.create({ data: u });
    unitMap.set(u.symbol, unit.id);
  }
  console.log('\n  ✅ Units ready\n');

  // ══════════════════════════════════════════════════════════════════════════
  // 3. Ingredient Categories
  // ══════════════════════════════════════════════════════════════════════════

  const ingCatDefs = [
    { name: 'Dairy',      description: 'Milk, cheese, butter, cream' },
    { name: 'Meat',       description: 'Chicken, beef, mutton' },
    { name: 'Vegetables', description: 'Fresh vegetables' },
    { name: 'Spices',     description: 'Spices and seasonings' },
    { name: 'Grains',     description: 'Flour, semolina, rice' },
    { name: 'Sauces',     description: 'Sauces and condiments' },
    { name: 'Beverages',  description: 'Drinks and syrups' },
    { name: 'Bakery',     description: 'Bread, buns, dough' },
  ];

  const ingCatMap = new Map<string, string>(); // name → id
  for (const ic of ingCatDefs) {
    const existing = await prisma.ingredientCategory.findFirst({ where: { name: ic.name } });
    const ingCat = existing ?? await prisma.ingredientCategory.create({ data: ic });
    ingCatMap.set(ic.name, ingCat.id);
  }
  console.log('  ✅ Ingredient categories ready\n');

  // ══════════════════════════════════════════════════════════════════════════
  // 4. Ingredients
  // ══════════════════════════════════════════════════════════════════════════

  type IngDef = {
    name: string; brand?: string; catName: string;
    unitSymbol: string; lowStockLevel: number; currentStock?: number;
  };

  const ingDefs: IngDef[] = [
    // Dairy
    { name: 'Mozzarella Cheese',  brand: "Olper's",     catName: 'Dairy',      unitSymbol: 'kg',   lowStockLevel: 5,   currentStock: 20  },
    { name: 'Cheddar Cheese',     brand: "Kraft",        catName: 'Dairy',      unitSymbol: 'kg',   lowStockLevel: 3,   currentStock: 10  },
    { name: 'Cream Cheese',       brand: "Philadelphia", catName: 'Dairy',      unitSymbol: 'kg',   lowStockLevel: 2,   currentStock: 8   },
    { name: 'Butter',             brand: 'Nurpur',       catName: 'Dairy',      unitSymbol: 'kg',   lowStockLevel: 5,   currentStock: 15  },
    { name: 'Fresh Cream',        brand: "Olper's",      catName: 'Dairy',      unitSymbol: 'L',    lowStockLevel: 3,   currentStock: 10  },
    // Meat
    { name: 'Chicken Breast',     brand: "K&N's",        catName: 'Meat',       unitSymbol: 'kg',   lowStockLevel: 10,  currentStock: 40  },
    { name: 'Beef Mince',         brand: 'Local',        catName: 'Meat',       unitSymbol: 'kg',   lowStockLevel: 5,   currentStock: 20  },
    { name: 'Beef Strips',        brand: 'Local',        catName: 'Meat',       unitSymbol: 'kg',   lowStockLevel: 5,   currentStock: 15  },
    { name: 'Chicken Tikka',      brand: "K&N's",        catName: 'Meat',       unitSymbol: 'kg',   lowStockLevel: 8,   currentStock: 30  },
    { name: 'Seekh Kebab',        brand: 'Local',        catName: 'Meat',       unitSymbol: 'pcs',  lowStockLevel: 50,  currentStock: 200 },
    { name: 'Beef Patty',         brand: "K&N's",        catName: 'Meat',       unitSymbol: 'pcs',  lowStockLevel: 50,  currentStock: 200 },
    { name: 'Chicken Fillet',     brand: "K&N's",        catName: 'Meat',       unitSymbol: 'pcs',  lowStockLevel: 30,  currentStock: 120 },
    // Vegetables
    { name: 'Tomato',             brand: 'Local',        catName: 'Vegetables', unitSymbol: 'kg',   lowStockLevel: 10,  currentStock: 30  },
    { name: 'Capsicum',           brand: 'Local',        catName: 'Vegetables', unitSymbol: 'kg',   lowStockLevel: 5,   currentStock: 15  },
    { name: 'Mushroom',           brand: 'Local',        catName: 'Vegetables', unitSymbol: 'kg',   lowStockLevel: 3,   currentStock: 10  },
    { name: 'Onion',              brand: 'Local',        catName: 'Vegetables', unitSymbol: 'kg',   lowStockLevel: 10,  currentStock: 40  },
    { name: 'Olives',             brand: 'Mister Olive', catName: 'Vegetables', unitSymbol: 'g',    lowStockLevel: 500, currentStock: 2000},
    { name: 'Jalapeño',           brand: 'Local',        catName: 'Vegetables', unitSymbol: 'g',    lowStockLevel: 300, currentStock: 1000},
    { name: 'Iceberg Lettuce',    brand: 'Local',        catName: 'Vegetables', unitSymbol: 'kg',   lowStockLevel: 5,   currentStock: 20  },
    { name: 'Cabbage',            brand: 'Local',        catName: 'Vegetables', unitSymbol: 'kg',   lowStockLevel: 5,   currentStock: 15  },
    { name: 'Garlic',             brand: 'Local',        catName: 'Vegetables', unitSymbol: 'kg',   lowStockLevel: 2,   currentStock: 8   },
    // Grains
    { name: 'Pizza Flour',        brand: 'Bake Parlor',  catName: 'Grains',     unitSymbol: 'kg',   lowStockLevel: 20,  currentStock: 80  },
    { name: 'Pasta Penne',        brand: 'Bake Parlor',  catName: 'Grains',     unitSymbol: 'kg',   lowStockLevel: 5,   currentStock: 20  },
    { name: 'Pasta Spaghetti',    brand: 'Bake Parlor',  catName: 'Grains',     unitSymbol: 'kg',   lowStockLevel: 5,   currentStock: 20  },
    // Sauces
    { name: 'Pizza Sauce',        brand: 'Mutti',        catName: 'Sauces',     unitSymbol: 'kg',   lowStockLevel: 5,   currentStock: 20  },
    { name: 'BBQ Sauce',          brand: 'Knorr',        catName: 'Sauces',     unitSymbol: 'kg',   lowStockLevel: 3,   currentStock: 10  },
    { name: 'Mayonnaise',         brand: 'Best Foods',   catName: 'Sauces',     unitSymbol: 'kg',   lowStockLevel: 5,   currentStock: 15  },
    { name: 'Ketchup',            brand: "Heinz",        catName: 'Sauces',     unitSymbol: 'kg',   lowStockLevel: 5,   currentStock: 20  },
    { name: 'Garlic Sauce',       brand: 'Local',        catName: 'Sauces',     unitSymbol: 'kg',   lowStockLevel: 3,   currentStock: 10  },
    { name: 'Chilli Sauce',       brand: 'National',     catName: 'Sauces',     unitSymbol: 'kg',   lowStockLevel: 3,   currentStock: 10  },
    { name: 'Alfredo Sauce',      brand: 'Knorr',        catName: 'Sauces',     unitSymbol: 'kg',   lowStockLevel: 2,   currentStock: 8   },
    { name: 'Arabiata Sauce',     brand: 'Mutti',        catName: 'Sauces',     unitSymbol: 'kg',   lowStockLevel: 2,   currentStock: 8   },
    // Spices
    { name: 'Salt',               brand: 'National',     catName: 'Spices',     unitSymbol: 'g',    lowStockLevel: 500, currentStock: 3000},
    { name: 'Black Pepper',       brand: 'National',     catName: 'Spices',     unitSymbol: 'g',    lowStockLevel: 200, currentStock: 1000},
    { name: 'Oregano',            brand: 'National',     catName: 'Spices',     unitSymbol: 'g',    lowStockLevel: 100, currentStock: 500 },
    { name: 'Red Chilli Flakes',  brand: 'National',     catName: 'Spices',     unitSymbol: 'g',    lowStockLevel: 200, currentStock: 800 },
    { name: 'Shawarma Spice Mix', brand: 'National',     catName: 'Spices',     unitSymbol: 'g',    lowStockLevel: 300, currentStock: 1200},
    // Bakery / Bread
    { name: 'Burger Bun',         brand: 'Bake Parlor',  catName: 'Bakery',     unitSymbol: 'pcs',  lowStockLevel: 50,  currentStock: 200 },
    { name: 'Shawarma Wrap',      brand: 'Bake Parlor',  catName: 'Bakery',     unitSymbol: 'pcs',  lowStockLevel: 50,  currentStock: 200 },
    // Beverages
    { name: 'Pepsi',              brand: 'PepsiCo',      catName: 'Beverages',  unitSymbol: 'ml',   lowStockLevel: 5000, currentStock: 24000 },
    { name: '7Up',                brand: 'PepsiCo',      catName: 'Beverages',  unitSymbol: 'ml',   lowStockLevel: 5000, currentStock: 24000 },
    { name: 'Mango Pulp',         brand: 'National',     catName: 'Beverages',  unitSymbol: 'kg',   lowStockLevel: 5,   currentStock: 20  },
    { name: 'Milk',               brand: "Olper's",      catName: 'Dairy',      unitSymbol: 'L',    lowStockLevel: 10,  currentStock: 40  },
  ];

  const ingMap = new Map<string, string>(); // name → id
  for (const ing of ingDefs) {
    const existing = await prisma.ingredient.findFirst({ where: { name: ing.name } });
    const created = existing ?? await prisma.ingredient.create({
      data: {
        name:          ing.name,
        brand:         ing.brand ?? null,
        categoryId:    ingCatMap.get(ing.catName) ?? null,
        unitId:        unitMap.get(ing.unitSymbol) ?? null,
        lowStockLevel: dec(ing.lowStockLevel),
        currentStock:  dec(ing.currentStock ?? 0),
        supplierId:    null,
        outletId:      null, // global catalog
      },
    });
    ingMap.set(ing.name, created.id);
  }
  console.log(`  ✅ ${ingDefs.length} ingredients ready\n`);

  // ══════════════════════════════════════════════════════════════════════════
  // 5. Modifiers
  // ══════════════════════════════════════════════════════════════════════════

  type ModDef = { name: string; price: number; type: string };
  const modDefs: ModDef[] = [
    { name: 'Extra Cheese',       price: 80,  type: 'addon' },
    { name: 'Extra Jalapeño',     price: 40,  type: 'addon' },
    { name: 'Extra Olives',       price: 40,  type: 'addon' },
    { name: 'Extra Mushrooms',    price: 50,  type: 'addon' },
    { name: 'Extra Mayo',         price: 30,  type: 'addon' },
    { name: 'Extra Patty',        price: 150, type: 'addon' },
    { name: 'No Onion',           price: 0,   type: 'removal' },
    { name: 'No Capsicum',        price: 0,   type: 'removal' },
    { name: 'No Mayo',            price: 0,   type: 'removal' },
    { name: 'No Cheese',          price: 0,   type: 'removal' },
    { name: 'Spicy',              price: 0,   type: 'addon' },
    { name: 'Extra Spicy',        price: 0,   type: 'addon' },
    { name: 'Well Done',          price: 0,   type: 'addon' },
  ];

  const modMap = new Map<string, string>(); // name → id
  for (const m of modDefs) {
    const existing = await prisma.modifier.findFirst({ where: { name: m.name } });
    const mod = existing ?? await prisma.modifier.create({
      data: { name: m.name, price: dec(m.price), type: m.type, status: 'active' },
    });
    modMap.set(m.name, mod.id);
  }
  console.log(`  ✅ ${modDefs.length} modifiers ready\n`);

  // ══════════════════════════════════════════════════════════════════════════
  // 6. Menu Items + Variants + Modifiers + Recipes
  // ══════════════════════════════════════════════════════════════════════════

  type VariantDef = {
    name: string; price: number; dineInPrice?: number;
    takeAwayPrice?: number; deliveryPrice?: number;
    displayOrder?: number;
    recipe?: Array<{ ingName: string; qty: number; unitSymbol: string }>;
  };

  type MenuItemDef = {
    name: string; catName: string; code: string;
    price: number; dineInPrice?: number;
    takeAwayPrice?: number; deliveryPrice?: number;
    cookingTime?: number;
    tags?: string[];
    variants?: VariantDef[];
    modifierNames?: string[];
    recipe?: Array<{ ingName: string; qty: number; unitSymbol: string }>;
  };

  const menuDefs: MenuItemDef[] = [
    // ──────── PIZZAS ────────────────────────────────────────────────────────
    {
      name: 'Margherita Pizza', catName: 'Pizza', code: 'PZ-001',
      price: 699, dineInPrice: 699, takeAwayPrice: 649, deliveryPrice: 749,
      cookingTime: 18, tags: ['vegetarian', 'classic'],
      modifierNames: ['Extra Cheese', 'Extra Jalapeño', 'Extra Olives', 'No Onion'],
      variants: [
        { name: 'Small (7")',   price: 499, dineInPrice: 499, takeAwayPrice: 469, deliveryPrice: 549, displayOrder: 1,
          recipe: [
            { ingName: 'Pizza Flour',     qty: 150, unitSymbol: 'g'   },
            { ingName: 'Pizza Sauce',     qty: 60,  unitSymbol: 'g'   },
            { ingName: 'Mozzarella Cheese', qty: 80, unitSymbol: 'g'  },
            { ingName: 'Tomato',          qty: 40,  unitSymbol: 'g'   },
            { ingName: 'Oregano',         qty: 2,   unitSymbol: 'g'   },
          ]},
        { name: 'Medium (10")', price: 699, dineInPrice: 699, takeAwayPrice: 649, deliveryPrice: 749, displayOrder: 2,
          recipe: [
            { ingName: 'Pizza Flour',     qty: 230, unitSymbol: 'g'   },
            { ingName: 'Pizza Sauce',     qty: 90,  unitSymbol: 'g'   },
            { ingName: 'Mozzarella Cheese', qty: 120, unitSymbol: 'g' },
            { ingName: 'Tomato',          qty: 60,  unitSymbol: 'g'   },
            { ingName: 'Oregano',         qty: 3,   unitSymbol: 'g'   },
          ]},
        { name: 'Large (14")',  price: 999, dineInPrice: 999, takeAwayPrice: 949, deliveryPrice: 1099, displayOrder: 3,
          recipe: [
            { ingName: 'Pizza Flour',     qty: 380, unitSymbol: 'g'   },
            { ingName: 'Pizza Sauce',     qty: 140, unitSymbol: 'g'   },
            { ingName: 'Mozzarella Cheese', qty: 200, unitSymbol: 'g' },
            { ingName: 'Tomato',          qty: 100, unitSymbol: 'g'   },
            { ingName: 'Oregano',         qty: 5,   unitSymbol: 'g'   },
          ]},
      ],
    },
    {
      name: 'BBQ Chicken Pizza', catName: 'Pizza', code: 'PZ-002',
      price: 849, dineInPrice: 849, takeAwayPrice: 799, deliveryPrice: 949,
      cookingTime: 20, tags: ['bestseller'],
      modifierNames: ['Extra Cheese', 'Extra Jalapeño', 'No Onion', 'No Capsicum'],
      variants: [
        { name: 'Small (7")',   price: 599, dineInPrice: 599, takeAwayPrice: 569, deliveryPrice: 649, displayOrder: 1,
          recipe: [
            { ingName: 'Pizza Flour',     qty: 150, unitSymbol: 'g' },
            { ingName: 'BBQ Sauce',       qty: 60,  unitSymbol: 'g' },
            { ingName: 'Mozzarella Cheese', qty: 80, unitSymbol: 'g' },
            { ingName: 'Chicken Tikka',   qty: 80,  unitSymbol: 'g' },
            { ingName: 'Capsicum',        qty: 30,  unitSymbol: 'g' },
            { ingName: 'Onion',           qty: 20,  unitSymbol: 'g' },
          ]},
        { name: 'Medium (10")', price: 849, dineInPrice: 849, takeAwayPrice: 799, deliveryPrice: 949, displayOrder: 2,
          recipe: [
            { ingName: 'Pizza Flour',     qty: 230, unitSymbol: 'g' },
            { ingName: 'BBQ Sauce',       qty: 90,  unitSymbol: 'g' },
            { ingName: 'Mozzarella Cheese', qty: 120, unitSymbol: 'g' },
            { ingName: 'Chicken Tikka',   qty: 120, unitSymbol: 'g' },
            { ingName: 'Capsicum',        qty: 50,  unitSymbol: 'g' },
            { ingName: 'Onion',           qty: 30,  unitSymbol: 'g' },
          ]},
        { name: 'Large (14")',  price: 1199, dineInPrice: 1199, takeAwayPrice: 1149, deliveryPrice: 1299, displayOrder: 3,
          recipe: [
            { ingName: 'Pizza Flour',     qty: 380, unitSymbol: 'g' },
            { ingName: 'BBQ Sauce',       qty: 140, unitSymbol: 'g' },
            { ingName: 'Mozzarella Cheese', qty: 200, unitSymbol: 'g' },
            { ingName: 'Chicken Tikka',   qty: 200, unitSymbol: 'g' },
            { ingName: 'Capsicum',        qty: 80,  unitSymbol: 'g' },
            { ingName: 'Onion',           qty: 50,  unitSymbol: 'g' },
          ]},
      ],
    },
    {
      name: 'Pepperoni Pizza', catName: 'Pizza', code: 'PZ-003',
      price: 899, dineInPrice: 899, takeAwayPrice: 849, deliveryPrice: 999,
      cookingTime: 20, tags: ['bestseller'],
      modifierNames: ['Extra Cheese', 'Extra Jalapeño', 'Extra Olives'],
      variants: [
        { name: 'Small (7")',   price: 649, displayOrder: 1,
          recipe: [{ ingName: 'Pizza Flour', qty: 150, unitSymbol: 'g' }, { ingName: 'Pizza Sauce', qty: 60, unitSymbol: 'g' }, { ingName: 'Mozzarella Cheese', qty: 80, unitSymbol: 'g' }, { ingName: 'Beef Strips', qty: 60, unitSymbol: 'g' }]},
        { name: 'Medium (10")', price: 899, displayOrder: 2,
          recipe: [{ ingName: 'Pizza Flour', qty: 230, unitSymbol: 'g' }, { ingName: 'Pizza Sauce', qty: 90, unitSymbol: 'g' }, { ingName: 'Mozzarella Cheese', qty: 130, unitSymbol: 'g' }, { ingName: 'Beef Strips', qty: 100, unitSymbol: 'g' }]},
        { name: 'Large (14")',  price: 1299, displayOrder: 3,
          recipe: [{ ingName: 'Pizza Flour', qty: 380, unitSymbol: 'g' }, { ingName: 'Pizza Sauce', qty: 140, unitSymbol: 'g' }, { ingName: 'Mozzarella Cheese', qty: 210, unitSymbol: 'g' }, { ingName: 'Beef Strips', qty: 160, unitSymbol: 'g' }]},
      ],
    },
    {
      name: 'Loaded Veggie Pizza', catName: 'Pizza', code: 'PZ-004',
      price: 749, dineInPrice: 749, takeAwayPrice: 699, deliveryPrice: 849,
      cookingTime: 18, tags: ['vegetarian'],
      modifierNames: ['Extra Cheese', 'Extra Mushrooms', 'Extra Olives', 'No Onion', 'No Capsicum'],
      variants: [
        { name: 'Small (7")',   price: 549, displayOrder: 1,
          recipe: [{ ingName: 'Pizza Flour', qty: 150, unitSymbol: 'g' }, { ingName: 'Pizza Sauce', qty: 60, unitSymbol: 'g' }, { ingName: 'Mozzarella Cheese', qty: 80, unitSymbol: 'g' }, { ingName: 'Capsicum', qty: 30, unitSymbol: 'g' }, { ingName: 'Mushroom', qty: 30, unitSymbol: 'g' }, { ingName: 'Olives', qty: 20, unitSymbol: 'g' }, { ingName: 'Onion', qty: 20, unitSymbol: 'g' }]},
        { name: 'Medium (10")', price: 749, displayOrder: 2,
          recipe: [{ ingName: 'Pizza Flour', qty: 230, unitSymbol: 'g' }, { ingName: 'Pizza Sauce', qty: 90, unitSymbol: 'g' }, { ingName: 'Mozzarella Cheese', qty: 120, unitSymbol: 'g' }, { ingName: 'Capsicum', qty: 50, unitSymbol: 'g' }, { ingName: 'Mushroom', qty: 50, unitSymbol: 'g' }, { ingName: 'Olives', qty: 30, unitSymbol: 'g' }, { ingName: 'Onion', qty: 30, unitSymbol: 'g' }]},
        { name: 'Large (14")',  price: 1049, displayOrder: 3,
          recipe: [{ ingName: 'Pizza Flour', qty: 380, unitSymbol: 'g' }, { ingName: 'Pizza Sauce', qty: 140, unitSymbol: 'g' }, { ingName: 'Mozzarella Cheese', qty: 200, unitSymbol: 'g' }, { ingName: 'Capsicum', qty: 80, unitSymbol: 'g' }, { ingName: 'Mushroom', qty: 80, unitSymbol: 'g' }, { ingName: 'Olives', qty: 50, unitSymbol: 'g' }, { ingName: 'Onion', qty: 50, unitSymbol: 'g' }]},
      ],
    },

    // ──────── BURGERS ────────────────────────────────────────────────────────
    {
      name: 'Classic Beef Burger', catName: 'Burgers', code: 'BG-001',
      price: 549, dineInPrice: 549, takeAwayPrice: 499, deliveryPrice: 599,
      cookingTime: 10, tags: ['bestseller'],
      modifierNames: ['Extra Cheese', 'Extra Patty', 'Extra Mayo', 'No Onion', 'No Mayo', 'Well Done'],
      recipe: [
        { ingName: 'Beef Patty',    qty: 1,   unitSymbol: 'pcs' },
        { ingName: 'Burger Bun',    qty: 1,   unitSymbol: 'pcs' },
        { ingName: 'Cheddar Cheese',qty: 30,  unitSymbol: 'g'   },
        { ingName: 'Iceberg Lettuce', qty: 20, unitSymbol: 'g'  },
        { ingName: 'Tomato',        qty: 30,  unitSymbol: 'g'   },
        { ingName: 'Onion',         qty: 20,  unitSymbol: 'g'   },
        { ingName: 'Mayonnaise',    qty: 20,  unitSymbol: 'g'   },
        { ingName: 'Ketchup',       qty: 15,  unitSymbol: 'g'   },
      ],
    },
    {
      name: 'Zinger Chicken Burger', catName: 'Burgers', code: 'BG-002',
      price: 499, dineInPrice: 499, takeAwayPrice: 449, deliveryPrice: 549,
      cookingTime: 12, tags: ['spicy', 'bestseller'],
      modifierNames: ['Extra Cheese', 'Extra Mayo', 'No Onion', 'No Mayo', 'Spicy', 'Extra Spicy'],
      recipe: [
        { ingName: 'Chicken Fillet',qty: 1,   unitSymbol: 'pcs' },
        { ingName: 'Burger Bun',    qty: 1,   unitSymbol: 'pcs' },
        { ingName: 'Iceberg Lettuce', qty: 20, unitSymbol: 'g'  },
        { ingName: 'Mayonnaise',    qty: 25,  unitSymbol: 'g'   },
        { ingName: 'Chilli Sauce',  qty: 15,  unitSymbol: 'g'   },
        { ingName: 'Onion',         qty: 20,  unitSymbol: 'g'   },
      ],
    },
    {
      name: 'BBQ Double Decker', catName: 'Burgers', code: 'BG-003',
      price: 749, dineInPrice: 749, takeAwayPrice: 699, deliveryPrice: 849,
      cookingTime: 14, tags: ['premium'],
      modifierNames: ['Extra Cheese', 'Extra Patty', 'No Onion', 'No Mayo', 'Well Done'],
      recipe: [
        { ingName: 'Beef Patty',    qty: 2,   unitSymbol: 'pcs' },
        { ingName: 'Burger Bun',    qty: 1,   unitSymbol: 'pcs' },
        { ingName: 'Cheddar Cheese',qty: 50,  unitSymbol: 'g'   },
        { ingName: 'BBQ Sauce',     qty: 30,  unitSymbol: 'g'   },
        { ingName: 'Iceberg Lettuce', qty: 20, unitSymbol: 'g'  },
        { ingName: 'Tomato',        qty: 30,  unitSymbol: 'g'   },
        { ingName: 'Onion',         qty: 20,  unitSymbol: 'g'   },
        { ingName: 'Mayonnaise',    qty: 20,  unitSymbol: 'g'   },
      ],
    },
    {
      name: 'Mushroom Swiss Burger', catName: 'Burgers', code: 'BG-004',
      price: 649, dineInPrice: 649, takeAwayPrice: 599, deliveryPrice: 699,
      cookingTime: 12, tags: ['premium'],
      modifierNames: ['Extra Cheese', 'Extra Mushrooms', 'No Onion', 'Well Done'],
      recipe: [
        { ingName: 'Beef Patty',    qty: 1,   unitSymbol: 'pcs' },
        { ingName: 'Burger Bun',    qty: 1,   unitSymbol: 'pcs' },
        { ingName: 'Mozzarella Cheese', qty: 40, unitSymbol: 'g'},
        { ingName: 'Mushroom',      qty: 60,  unitSymbol: 'g'   },
        { ingName: 'Garlic Sauce',  qty: 25,  unitSymbol: 'g'   },
        { ingName: 'Iceberg Lettuce', qty: 20, unitSymbol: 'g'  },
        { ingName: 'Onion',         qty: 20,  unitSymbol: 'g'   },
      ],
    },

    // ──────── PASTA ─────────────────────────────────────────────────────────
    {
      name: 'Penne Alfredo', catName: 'Pasta', code: 'PA-001',
      price: 549, dineInPrice: 549, takeAwayPrice: 499, deliveryPrice: 599,
      cookingTime: 15, tags: ['creamy'],
      modifierNames: ['Extra Cheese', 'Spicy'],
      recipe: [
        { ingName: 'Pasta Penne',   qty: 120, unitSymbol: 'g' },
        { ingName: 'Alfredo Sauce', qty: 100, unitSymbol: 'g' },
        { ingName: 'Fresh Cream',   qty: 50,  unitSymbol: 'ml'},
        { ingName: 'Mozzarella Cheese', qty: 40, unitSymbol: 'g' },
        { ingName: 'Black Pepper',  qty: 2,   unitSymbol: 'g' },
        { ingName: 'Butter',        qty: 15,  unitSymbol: 'g' },
      ],
    },
    {
      name: 'Chicken Arabiata', catName: 'Pasta', code: 'PA-002',
      price: 649, dineInPrice: 649, takeAwayPrice: 599, deliveryPrice: 699,
      cookingTime: 15, tags: ['spicy'],
      modifierNames: ['Extra Cheese', 'Spicy', 'Extra Spicy'],
      recipe: [
        { ingName: 'Pasta Penne',    qty: 120, unitSymbol: 'g' },
        { ingName: 'Arabiata Sauce', qty: 100, unitSymbol: 'g' },
        { ingName: 'Chicken Breast', qty: 100, unitSymbol: 'g' },
        { ingName: 'Capsicum',       qty: 30,  unitSymbol: 'g' },
        { ingName: 'Onion',          qty: 20,  unitSymbol: 'g' },
        { ingName: 'Garlic',         qty: 10,  unitSymbol: 'g' },
        { ingName: 'Red Chilli Flakes', qty: 3, unitSymbol: 'g' },
      ],
    },
    {
      name: 'Spaghetti Bolognese', catName: 'Pasta', code: 'PA-003',
      price: 699, dineInPrice: 699, takeAwayPrice: 649, deliveryPrice: 749,
      cookingTime: 18, tags: ['classic'],
      modifierNames: ['Extra Cheese', 'Spicy'],
      recipe: [
        { ingName: 'Pasta Spaghetti', qty: 120, unitSymbol: 'g' },
        { ingName: 'Beef Mince',      qty: 100, unitSymbol: 'g' },
        { ingName: 'Tomato',          qty: 80,  unitSymbol: 'g' },
        { ingName: 'Onion',           qty: 30,  unitSymbol: 'g' },
        { ingName: 'Garlic',          qty: 10,  unitSymbol: 'g' },
        { ingName: 'Pizza Sauce',     qty: 60,  unitSymbol: 'g' },
        { ingName: 'Black Pepper',    qty: 2,   unitSymbol: 'g' },
        { ingName: 'Mozzarella Cheese', qty: 30, unitSymbol: 'g' },
      ],
    },

    // ──────── SHAWARMA ──────────────────────────────────────────────────────
    {
      name: 'Chicken Shawarma', catName: 'Shawarma', code: 'SW-001',
      price: 349, dineInPrice: 349, takeAwayPrice: 299, deliveryPrice: 399,
      cookingTime: 8, tags: ['bestseller'],
      modifierNames: ['Extra Mayo', 'Extra Cheese', 'No Onion', 'Spicy', 'Extra Spicy'],
      variants: [
        { name: 'Regular', price: 349, displayOrder: 1,
          recipe: [{ ingName: 'Chicken Tikka', qty: 80, unitSymbol: 'g' }, { ingName: 'Shawarma Wrap', qty: 1, unitSymbol: 'pcs' }, { ingName: 'Cabbage', qty: 30, unitSymbol: 'g' }, { ingName: 'Onion', qty: 20, unitSymbol: 'g' }, { ingName: 'Tomato', qty: 20, unitSymbol: 'g' }, { ingName: 'Garlic Sauce', qty: 30, unitSymbol: 'g' }, { ingName: 'Shawarma Spice Mix', qty: 5, unitSymbol: 'g' }]},
        { name: 'Large',   price: 499, displayOrder: 2,
          recipe: [{ ingName: 'Chicken Tikka', qty: 130, unitSymbol: 'g' }, { ingName: 'Shawarma Wrap', qty: 1, unitSymbol: 'pcs' }, { ingName: 'Cabbage', qty: 50, unitSymbol: 'g' }, { ingName: 'Onion', qty: 30, unitSymbol: 'g' }, { ingName: 'Tomato', qty: 30, unitSymbol: 'g' }, { ingName: 'Garlic Sauce', qty: 40, unitSymbol: 'g' }, { ingName: 'Shawarma Spice Mix', qty: 8, unitSymbol: 'g' }]},
      ],
    },
    {
      name: 'Beef Seekh Shawarma', catName: 'Shawarma', code: 'SW-002',
      price: 399, dineInPrice: 399, takeAwayPrice: 349, deliveryPrice: 449,
      cookingTime: 10, tags: ['spicy'],
      modifierNames: ['Extra Mayo', 'No Onion', 'Spicy', 'Extra Spicy'],
      recipe: [
        { ingName: 'Seekh Kebab',       qty: 2,  unitSymbol: 'pcs' },
        { ingName: 'Shawarma Wrap',     qty: 1,  unitSymbol: 'pcs' },
        { ingName: 'Cabbage',           qty: 30, unitSymbol: 'g'   },
        { ingName: 'Onion',             qty: 20, unitSymbol: 'g'   },
        { ingName: 'Tomato',            qty: 20, unitSymbol: 'g'   },
        { ingName: 'Garlic Sauce',      qty: 30, unitSymbol: 'g'   },
        { ingName: 'Chilli Sauce',      qty: 15, unitSymbol: 'g'   },
        { ingName: 'Shawarma Spice Mix',qty: 5,  unitSymbol: 'g'   },
      ],
    },

    // ──────── APPETIZERS ────────────────────────────────────────────────────
    {
      name: 'Loaded Fries', catName: 'Appetizers', code: 'AP-001',
      price: 299, dineInPrice: 299, takeAwayPrice: 279, deliveryPrice: 329,
      cookingTime: 8, tags: ['vegetarian'],
      modifierNames: ['Extra Cheese', 'Extra Jalapeño', 'Spicy'],
      recipe: [
        { ingName: 'Cheddar Cheese',  qty: 50, unitSymbol: 'g' },
        { ingName: 'Jalapeño',        qty: 20, unitSymbol: 'g' },
        { ingName: 'Mayonnaise',      qty: 30, unitSymbol: 'g' },
        { ingName: 'Ketchup',         qty: 20, unitSymbol: 'g' },
      ],
    },
    {
      name: 'Garlic Bread', catName: 'Appetizers', code: 'AP-002',
      price: 199, dineInPrice: 199, takeAwayPrice: 179, deliveryPrice: 229,
      cookingTime: 6, tags: ['vegetarian'],
      modifierNames: ['Extra Cheese'],
      recipe: [
        { ingName: 'Butter',          qty: 40, unitSymbol: 'g' },
        { ingName: 'Garlic',          qty: 15, unitSymbol: 'g' },
        { ingName: 'Mozzarella Cheese', qty: 40, unitSymbol: 'g' },
        { ingName: 'Oregano',         qty: 2,  unitSymbol: 'g' },
      ],
    },
    {
      name: 'Chicken Wings', catName: 'Appetizers', code: 'AP-003',
      price: 499, dineInPrice: 499, takeAwayPrice: 449, deliveryPrice: 549,
      cookingTime: 14, tags: ['spicy', 'bestseller'],
      modifierNames: ['Spicy', 'Extra Spicy', 'Extra Mayo'],
      recipe: [
        { ingName: 'Chicken Breast',  qty: 250, unitSymbol: 'g' },
        { ingName: 'BBQ Sauce',       qty: 40,  unitSymbol: 'g' },
        { ingName: 'Chilli Sauce',    qty: 20,  unitSymbol: 'g' },
        { ingName: 'Black Pepper',    qty: 3,   unitSymbol: 'g' },
        { ingName: 'Salt',            qty: 3,   unitSymbol: 'g' },
      ],
    },

    // ──────── BEVERAGES ─────────────────────────────────────────────────────
    {
      name: 'Pepsi', catName: 'Beverages', code: 'BV-001',
      price: 100, dineInPrice: 100, takeAwayPrice: 80, deliveryPrice: 120,
      cookingTime: 0, tags: [],
      variants: [
        { name: 'Regular (345ml)', price: 100, displayOrder: 1, recipe: [{ ingName: 'Pepsi', qty: 345, unitSymbol: 'ml' }] },
        { name: 'Large (500ml)',   price: 150, displayOrder: 2, recipe: [{ ingName: 'Pepsi', qty: 500, unitSymbol: 'ml' }] },
      ],
    },
    {
      name: '7Up', catName: 'Beverages', code: 'BV-002',
      price: 100, dineInPrice: 100, takeAwayPrice: 80, deliveryPrice: 120,
      cookingTime: 0, tags: [],
      variants: [
        { name: 'Regular (345ml)', price: 100, displayOrder: 1, recipe: [{ ingName: '7Up', qty: 345, unitSymbol: 'ml' }] },
        { name: 'Large (500ml)',   price: 150, displayOrder: 2, recipe: [{ ingName: '7Up', qty: 500, unitSymbol: 'ml' }] },
      ],
    },
    {
      name: 'Fresh Mango Smoothie', catName: 'Beverages', code: 'BV-003',
      price: 249, dineInPrice: 249, takeAwayPrice: 229, deliveryPrice: 279,
      cookingTime: 3, tags: ['fresh'],
      recipe: [
        { ingName: 'Mango Pulp', qty: 120, unitSymbol: 'g'  },
        { ingName: 'Milk',       qty: 200, unitSymbol: 'ml' },
        { ingName: 'Fresh Cream',qty: 30,  unitSymbol: 'ml' },
      ],
    },

    // ──────── DESSERTS ─────────────────────────────────────────────────────
    {
      name: 'Nutella Lava Waffle', catName: 'Desserts', code: 'DS-001',
      price: 349, dineInPrice: 349, takeAwayPrice: 329, deliveryPrice: 399,
      cookingTime: 8, tags: ['sweet'],
      modifierNames: ['Extra Cheese'],
      recipe: [
        { ingName: 'Pizza Flour',  qty: 80,  unitSymbol: 'g'  },
        { ingName: 'Butter',       qty: 30,  unitSymbol: 'g'  },
        { ingName: 'Milk',         qty: 60,  unitSymbol: 'ml' },
        { ingName: 'Fresh Cream',  qty: 40,  unitSymbol: 'ml' },
      ],
    },
    {
      name: 'Tiramisu', catName: 'Desserts', code: 'DS-002',
      price: 299, dineInPrice: 299, takeAwayPrice: 279, deliveryPrice: 349,
      cookingTime: 2, tags: ['sweet', 'classic'],
      recipe: [
        { ingName: 'Fresh Cream',   qty: 100, unitSymbol: 'ml' },
        { ingName: 'Cream Cheese',  qty: 50,  unitSymbol: 'g'  },
        { ingName: 'Milk',          qty: 50,  unitSymbol: 'ml' },
      ],
    },
  ];

  // ── Upsert all menu items, variants, modifiers, recipes ──────────────────

  let itemCount = 0, variantCount = 0, recipeCount = 0;

  for (const def of menuDefs) {
    // Check if already exists
    let item = await prisma.foodMenuItem.findFirst({ where: { code: def.code } });

    if (!item) {
      item = await prisma.foodMenuItem.create({
        data: {
          name:          def.name,
          code:          def.code,
          categoryId:    catMap.get(def.catName) ?? null,
          price:         dec(def.price),
          dineInPrice:   def.dineInPrice   != null ? dec(def.dineInPrice)   : null,
          takeAwayPrice: def.takeAwayPrice  != null ? dec(def.takeAwayPrice) : null,
          deliveryPrice: def.deliveryPrice  != null ? dec(def.deliveryPrice) : null,
          available:     true,
          cookingTime:   def.cookingTime ?? 0,
          tags:          def.tags ?? [],
        },
      });
      itemCount++;
    }

    // Variants
    if (def.variants && def.variants.length > 0) {
      for (const v of def.variants) {
        let variant = await prisma.foodMenuVariant.findFirst({
          where: { menuItemId: item.id, name: v.name },
        });
        if (!variant) {
          variant = await prisma.foodMenuVariant.create({
            data: {
              menuItemId:    item.id,
              name:          v.name,
              price:         dec(v.price),
              dineInPrice:   v.dineInPrice   != null ? dec(v.dineInPrice)   : null,
              takeAwayPrice: v.takeAwayPrice  != null ? dec(v.takeAwayPrice) : null,
              deliveryPrice: v.deliveryPrice  != null ? dec(v.deliveryPrice) : null,
              displayOrder:  v.displayOrder ?? 0,
            },
          });
          variantCount++;
        }

        // Recipes for variant
        if (v.recipe) {
          for (const r of v.recipe) {
            const ingId  = ingMap.get(r.ingName);
            const unitId = unitMap.get(r.unitSymbol);
            if (!ingId || !unitId) continue;
            const exists = await prisma.foodRecipe.findFirst({
              where: { menuItemId: item.id, variantId: variant.id, ingredientId: ingId },
            });
            if (!exists) {
              await prisma.foodRecipe.create({
                data: { menuItemId: item.id, variantId: variant.id, ingredientId: ingId, qtyPerUnit: dec(r.qty), usageUnitId: unitId },
              });
              recipeCount++;
            }
          }
        }
      }
    }

    // Base item recipes (no variant)
    if (def.recipe) {
      for (const r of def.recipe) {
        const ingId  = ingMap.get(r.ingName);
        const unitId = unitMap.get(r.unitSymbol);
        if (!ingId || !unitId) continue;
        const exists = await prisma.foodRecipe.findFirst({
          where: { menuItemId: item.id, variantId: null, ingredientId: ingId },
        });
        if (!exists) {
          await prisma.foodRecipe.create({
            data: { menuItemId: item.id, variantId: null, ingredientId: ingId, qtyPerUnit: dec(r.qty), usageUnitId: unitId },
          });
          recipeCount++;
        }
      }
    }

    // Modifiers
    if (def.modifierNames) {
      for (const mName of def.modifierNames) {
        const modId = modMap.get(mName);
        if (!modId) continue;
        const exists = await prisma.menuItemModifier.findFirst({
          where: { menuItemId: item.id, modifierId: modId },
        });
        if (!exists) {
          await prisma.menuItemModifier.create({
            data: { menuItemId: item.id, modifierId: modId, variantIds: [] },
          });
        }
      }
    }
  }

  console.log(`  ✅ ${itemCount} menu items created`);
  console.log(`  ✅ ${variantCount} variants created`);
  console.log(`  ✅ ${recipeCount} recipe rows created`);

  // Dynamically update Main Kitchen to include all seeded categories so they show up on KDS
  const allCategories = await prisma.foodCategory.findMany();
  const catNames = allCategories.map(c => c.name);
  const kitchen = await prisma.kitchen.findFirst({ where: { name: 'Main Kitchen' } });
  if (kitchen) {
    await prisma.kitchen.update({
      where: { id: kitchen.id },
      data: { assignedCategories: catNames }
    });
    console.log(`  ✅ Updated Main Kitchen assigned categories to: ${JSON.stringify(catNames)}`);
  }

  console.log('\n🎉 Menu seed complete!');
  console.log('   Items: Pizza × 4 | Burgers × 4 | Pasta × 3 | Shawarma × 2 | Appetizers × 3 | Beverages × 3 | Desserts × 2');
}

main()
  .catch((e) => { console.error('❌ Seed error:', e); process.exit(1); })
  .finally(() => prisma.$disconnect());
