import { PrismaClient } from '@prisma/client';
import dotenv from 'dotenv';

dotenv.config();

async function testUrl(name: string, url: string) {
  console.log(`\n--- Testing ${name} ---`);
  console.log(`URL: ${url.replace(/:[^:@]+@/, ':****@')}`);
  const client = new PrismaClient({
    datasources: { db: { url } },
  });

  try {
    const start = Date.now();
    const count = await client.foodMenuItem.count();
    const ms = Date.now() - start;
    console.log(`✅ Success! Food menu items count: ${count} (${ms}ms)`);
  } catch (err: any) {
    console.error(`❌ Error: ${err.message}`);
  } finally {
    await client.$disconnect();
  }
}

async function main() {
  const dbUrl = process.env.DATABASE_URL || '';
  const directUrl = process.env.DIRECT_URL || '';

  await testUrl('Current DATABASE_URL', dbUrl);
  await testUrl('Current DIRECT_URL', directUrl);

  // Test pooled with pgbouncer=true & connect_timeout=30
  const cleanDbUrl = dbUrl.replace('&channel_binding=require', '') + '&connect_timeout=30&pgbouncer=true';
  await testUrl('Cleaned DATABASE_URL (no channel_binding + pgbouncer=true)', cleanDbUrl);
}

main().catch(console.error);
