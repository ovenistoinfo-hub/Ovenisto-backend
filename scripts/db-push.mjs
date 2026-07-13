/**
 * Retry wrapper for `prisma db push`
 * Neon serverless can take 5-10s to wake from cold start — this retries
 * until success or max attempts reached. Works on Windows, Linux, Mac.
 */
import { execSync } from 'child_process';

const MAX_RETRIES = 6;
const WAIT_MS = 6000;

const acceptDataLoss = process.argv.includes('--accept-data-loss') || process.env.PRISMA_ACCEPT_DATA_LOSS === 'true';
const pushCommand = acceptDataLoss ? 'npx prisma db push --accept-data-loss' : 'npx prisma db push';

for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
  try {
    console.log(`\n🔄 ${pushCommand} — attempt ${attempt}/${MAX_RETRIES}`);
    execSync(pushCommand, { stdio: 'inherit' });
    console.log('\n✅ db push succeeded\n');
    process.exit(0);
  } catch {
    if (attempt === MAX_RETRIES) {
      console.error('\n❌ db push failed after all retries\n');
      process.exit(1);
    }
    console.log(`⏳ Neon may be waking up — waiting ${WAIT_MS / 1000}s before retry...`);
    await new Promise((r) => setTimeout(r, WAIT_MS));
  }
}
