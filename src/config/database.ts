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
 * Keep-alive ping — prevents Neon serverless cold starts by pinging every 4 minutes.
 * Returns the interval handle so it can be cleared on shutdown.
 */
export function startKeepAlive(): ReturnType<typeof setInterval> {
  const INTERVAL_MS = 4 * 60 * 1000; // 4 minutes (Neon sleeps after 5)
  return setInterval(async () => {
    try {
      await prisma.$queryRaw`SELECT 1`;
    } catch {
      // Silently ignore — connectDatabase retry logic handles reconnects
    }
  }, INTERVAL_MS);
}
