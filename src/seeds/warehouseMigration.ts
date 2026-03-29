/**
 * Warehouse Migration Seed Script
 * Creates initial warehouse structure and stock records
 */

import { prisma } from '../config/database.js';

async function main() {
  console.log('🏢 Starting warehouse migration...');

  // Check if warehouses already exist (idempotent)
  const existing = await prisma.warehouse.findFirst();
  if (existing) {
    console.log('✓ Warehouses already created, skipping migration');
    return;
  }

  // 1. Create MAIN warehouse
  const mainWarehouse = await prisma.warehouse.create({
    data: {
      name: 'Main Warehouse',
      code: 'MA-001',
      type: 'MAIN',
      outletId: null,
      managerId: null,
    },
  });
  console.log(`✓ Created MAIN warehouse: ${mainWarehouse.name}`);

  // 2. Get all active outlets and create BRANCH + KITCHEN warehouses for each
  const outlets = await prisma.outlet.findMany({ where: { isActive: true } });
  let branchIndex = 1;
  let kitchenIndex = 1;

  for (const outlet of outlets) {
    // Create BRANCH warehouse
    const branchCode = `BR-${String(branchIndex).padStart(3, '0')}`;
    const branch = await prisma.warehouse.create({
      data: {
        name: `${outlet.name} Store`,
        code: branchCode,
        type: 'BRANCH',
        outletId: outlet.id,
      },
    });
    console.log(`✓ Created BRANCH warehouse: ${branch.name}`);
    branchIndex++;

    // Create KITCHEN warehouse
    const kitchenCode = `KI-${String(kitchenIndex).padStart(3, '0')}`;
    const kitchen = await prisma.warehouse.create({
      data: {
        name: `${outlet.name} Kitchen`,
        code: kitchenCode,
        type: 'KITCHEN',
        outletId: outlet.id,
      },
    });
    console.log(`✓ Created KITCHEN warehouse: ${kitchen.name}`);
    kitchenIndex++;
  }

  // 3. Get all active ingredients with stock and create WarehouseStock records
  const ingredients = await prisma.ingredient.findMany({
    where: { status: 'active' },
  });

  const allWarehouses = await prisma.warehouse.findMany();

  for (const ingredient of ingredients) {
    // Create stock record in MAIN warehouse with existing stock
    await prisma.warehouseStock.create({
      data: {
        warehouseId: mainWarehouse.id,
        ingredientId: ingredient.id,
        currentStock: ingredient.currentStock,
        lowStockLevel: ingredient.lowStockLevel,
      },
    });

    // Create stock records in all other warehouses with 0 stock but correct lowStockLevel
    for (const warehouse of allWarehouses) {
      if (warehouse.id !== mainWarehouse.id) {
        try {
          await prisma.warehouseStock.create({
            data: {
              warehouseId: warehouse.id,
              ingredientId: ingredient.id,
              currentStock: 0,
              lowStockLevel: ingredient.lowStockLevel,
            },
          });
        } catch (e: any) {
          // Skip unique constraint errors (already exists)
          if (e.code !== 'P2002') throw e;
        }
      }
    }
  }

  console.log(`✓ Created warehouse stock records for ${ingredients.length} ingredients`);

  // Summary
  const warehouseCount = await prisma.warehouse.count();
  const stockCount = await prisma.warehouseStock.count();
  console.log(`\n✅ Migration complete!`);
  console.log(`   Created ${warehouseCount} warehouses`);
  console.log(`   Created ${stockCount} stock records`);
}

main()
  .catch((e) => {
    console.error('❌ Migration failed:', e.message);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
