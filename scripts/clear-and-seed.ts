import { PrismaClient } from '@prisma/client';
import { execSync } from 'child_process';

const prisma = new PrismaClient();

async function main() {
  console.log('🗑️ Clearing database...');

  // Get all table names in public schema
  const tablenames = await prisma.$queryRaw<Array<{ tablename: string }>>`
    SELECT tablename FROM pg_tables WHERE schemaname='public'
  `;

  const tables = tablenames
    .map(({ tablename }) => tablename)
    .filter((name) => name !== '_prisma_migrations')
    .map((name) => `"${name}"`)
    .join(', ');

  try {
    if (tables.length > 0) {
      await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${tables} CASCADE;`);
      console.log('✅ Database cleared successfully.');
    }
  } catch (error) {
    console.error('❌ Failed to clear database:', error);
  } finally {
    await prisma.$disconnect();
  }

  console.log('🌱 Seeding database...');
  try {
    execSync('npx tsx prisma/seed.ts', { stdio: 'inherit' });
    console.log('✅ Database seeded successfully.');
  } catch (error) {
    console.error('❌ Failed to seed database:', error);
  }
}

main();
