/**
 * Auto Expiry Processor
 * Automatically detects expired StockBatch and ProductionBatch rows,
 * zeroes out their remaining quantity, decrements active stock,
 * and records a WasteRecord for each expired batch.
 */

import { prisma } from '../../config/database.js';
import { effectiveExpiry } from './dough.helpers.js';

export function isStockBatchExpired(
  createdAt: Date,
  expiryDate: Date | null,
  batchShelfLifeMinutes: number | null,
  ingredientShelfLifeHours: number | null,
  now: Date = new Date()
): boolean {
  if (expiryDate != null) {
    return new Date(expiryDate).getTime() <= now.getTime();
  }
  if (batchShelfLifeMinutes != null || ingredientShelfLifeHours != null) {
    const exp = effectiveExpiry(createdAt, batchShelfLifeMinutes, ingredientShelfLifeHours);
    return exp.getTime() <= now.getTime();
  }
  return false;
}

export function isProductionBatchExpired(
  createdAt: Date,
  batchShelfLifeMinutes: number | null,
  itemShelfLifeHours: number | null,
  now: Date = new Date()
): boolean {
  if (batchShelfLifeMinutes != null || itemShelfLifeHours != null) {
    const totalMinutes = batchShelfLifeMinutes ?? (itemShelfLifeHours != null ? itemShelfLifeHours * 60 : null);
    if (totalMinutes != null) {
      const exp = new Date(createdAt.getTime() + totalMinutes * 60 * 1000);
      return exp.getTime() <= now.getTime();
    }
  }
  return false;
}

export async function autoProcessExpiredBatches(): Promise<{
  stockBatchesWasted: number;
  productionBatchesWasted: number;
}> {
  const now = new Date();

  // 1. Process Expired StockBatches (raw ingredients / dough)
  const candidateStockBatches = await prisma.stockBatch.findMany({
    where: {
      remainingQty: { gt: 0 },
    },
    include: {
      ingredient: {
        select: { id: true, name: true, purchasePrice: true, shelfLifeHours: true, unit: { select: { name: true } } },
      },
      warehouse: {
        select: { id: true, outletId: true },
      },
    },
  });

  const expiredStockBatches = candidateStockBatches.filter((b) =>
    isStockBatchExpired(
      b.createdAt,
      b.expiryDate,
      b.shelfLifeMinutes,
      b.ingredient?.shelfLifeHours ?? null,
      now
    )
  );

  let stockBatchesWasted = 0;
  for (const b of expiredStockBatches) {
    try {
      await prisma.$transaction(async (tx) => {
        const remaining = Number(b.remainingQty);
        if (remaining <= 0) return;

        // Atomic zero: only proceed if remainingQty is still > 0
        const updated = await tx.stockBatch.updateMany({
          where: { id: b.id, remainingQty: { gt: 0 } },
          data: { remainingQty: 0 },
        });

        if (updated.count > 0) {
          // Decrement global ingredient stock safely
          const ing = await tx.ingredient.findUnique({ where: { id: b.ingredientId }, select: { currentStock: true } });
          if (ing) {
            await tx.ingredient.update({
              where: { id: b.ingredientId },
              data: { currentStock: Math.max(0, Number(ing.currentStock) - remaining) },
            });
          }

          // Decrement warehouse stock safely
          if (b.warehouseId) {
            const ws = await tx.warehouseStock.findUnique({
              where: { warehouseId_ingredientId: { warehouseId: b.warehouseId, ingredientId: b.ingredientId } },
              select: { currentStock: true },
            });
            if (ws) {
              await tx.warehouseStock.update({
                where: { warehouseId_ingredientId: { warehouseId: b.warehouseId, ingredientId: b.ingredientId } },
                data: { currentStock: Math.max(0, Number(ws.currentStock) - remaining) },
              });
            }
          }

          // Create WasteRecord
          const unitCost = b.unitCost != null ? Number(b.unitCost) : Number(b.ingredient.purchasePrice ?? 0);
          await tx.wasteRecord.create({
            data: {
              itemName: b.ingredient.name,
              quantity: remaining,
              unit: b.ingredient.unit?.name ?? null,
              cost: unitCost * remaining,
              reason: b.shelfLifeMinutes != null || b.ingredient.shelfLifeHours != null
                ? 'Expired (short shelf life)'
                : 'Expired (batch expiry)',
              outletId: b.warehouse?.outletId || null,
              warehouseId: b.warehouseId || null,
              recordedBy: 'System (Auto Expiry)',
              date: now,
            },
          });
          stockBatchesWasted++;
        }
      }, { timeout: 30000 });
    } catch (err) {
      console.error(`Error auto-wasting stockBatch ${b.id}:`, err);
    }
  }

  // 2. Process Expired ProductionBatches (production items - 3rd stock layer)
  const candidateProdBatches = await prisma.productionBatch.findMany({
    where: {
      remainingQty: { gt: 0 },
    },
    include: {
      productionItem: {
        select: { id: true, name: true, unit: true, shelfLifeHours: true },
      },
      warehouse: {
        select: { id: true, outletId: true },
      },
    },
  });

  const expiredProdBatches = candidateProdBatches.filter((b) =>
    isProductionBatchExpired(
      b.createdAt,
      b.shelfLifeMinutes,
      b.productionItem?.shelfLifeHours ?? null,
      now
    )
  );

  let productionBatchesWasted = 0;
  for (const b of expiredProdBatches) {
    try {
      await prisma.$transaction(async (tx) => {
        const remaining = Number(b.remainingQty);
        if (remaining <= 0) return;

        const updated = await tx.productionBatch.updateMany({
          where: { id: b.id, remainingQty: { gt: 0 } },
          data: { remainingQty: 0 },
        });

        if (updated.count > 0) {
          const pws = await tx.productionWarehouseStock.findFirst({
            where: { productionItemId: b.productionItemId, warehouseId: b.warehouseId },
            select: { id: true, currentStock: true },
          });
          if (pws) {
            await tx.productionWarehouseStock.update({
              where: { id: pws.id },
              data: { currentStock: Math.max(0, Number(pws.currentStock) - remaining) },
            });
          }

          const unitCost = b.unitCost != null ? Number(b.unitCost) : 0;
          await tx.wasteRecord.create({
            data: {
              itemName: b.productionItem.name,
              quantity: remaining,
              unit: b.productionItem.unit ?? null,
              cost: unitCost * remaining,
              reason: 'Expired (auto waste)',
              outletId: b.warehouse?.outletId || null,
              warehouseId: b.warehouseId || null,
              recordedBy: 'System (Auto Expiry)',
              date: now,
            },
          });
          productionBatchesWasted++;
        }
      }, { timeout: 30000 });
    } catch (err) {
      console.error(`Error auto-wasting productionBatch ${b.id}:`, err);
    }
  }

  return { stockBatchesWasted, productionBatchesWasted };
}
