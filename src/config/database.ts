/**
 * Prisma Database Client Singleton
 */

import { PrismaClient } from '@prisma/client';
import { env } from './env.js';

// Prevent multiple instances in development (hot reload)
const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: env.NODE_ENV === 'development' ? ['query', 'error', 'warn'] : ['error'],
  });

if (env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = prisma;
}

/**
 * Connect to database with retry logic
 */
export async function connectDatabase(): Promise<void> {
  const maxRetries = 8;
  let retries = 0;

  while (retries < maxRetries) {
    try {
      await prisma.$connect();
      console.log('✅ Database connected successfully');
      await sanitizeNegativeStock();
      return;
    } catch (error) {
      retries++;
      console.error(`❌ Database connection failed (attempt ${retries}/${maxRetries}):`, error);

      if (retries === maxRetries) {
        throw error;
      }

      // Neon serverless can take 5-10s to wake from cold start — wait longer between retries
      const waitMs = retries <= 2 ? 3000 : 5000;
      console.log(`⏳ Waiting ${waitMs / 1000}s before retry...`);
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
  }
}

/**
 * Disconnect from database
 */
export async function disconnectDatabase(): Promise<void> {
  await prisma.$disconnect();
  console.log('📴 Database disconnected');
}

/**
  Sanitize negative stock values across ingredients, warehouse_stock, and production_warehouse_stock
 */
export async function sanitizeNegativeStock(): Promise<void> {
  try {
    await prisma.$executeRaw`UPDATE "ingredients" SET "currentStock" = 0 WHERE "currentStock" < 0`;
    await prisma.$executeRaw`UPDATE "warehouse_stock" SET "currentStock" = 0 WHERE "currentStock" < 0`;
    await prisma.$executeRaw`UPDATE "production_warehouse_stock" SET "currentStock" = 0 WHERE "currentStock" < 0`;
    console.log('🧹 Negative stock values sanitized');
  } catch (err) {
    console.error('⚠️ Failed to sanitize negative stock:', err);
  }
}

// NOTE: A keep-alive ping was intentionally REMOVED here. Pinging the DB on an
// interval defeats Neon's scale-to-zero and pins compute awake 24/7 (~180 CU-hrs/mo).
// We accept an occasional cold-start (~3-10s) on the first request after idle;
// connectDatabase()'s retry loop above handles wake-from-suspend transparently.
