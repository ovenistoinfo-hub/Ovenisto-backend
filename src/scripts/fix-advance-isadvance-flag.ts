/**
 * One-time fix script: set isAdvance=true for PaymentLog rows that are advance
 * payments but were stored with isAdvance=false due to a bug.
 *
 * A row is identified as an advance if:
 *   - notes starts with 'Salary Advance'
 *   - isAdvance is false (wrong)
 *
 * Run: npx ts-node src/scripts/fix-advance-isadvance-flag.ts
 */
import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function main() {
  // Find all payment logs that look like advances but have isAdvance=false
  const wrongLogs = await prisma.paymentLog.findMany({
    where: {
      isAdvance: false,
      notes: { startsWith: 'Salary Advance' },
    },
    select: { id: true, employeeId: true, startDate: true, endDate: true, notes: true, finalPay: true },
  });

  if (wrongLogs.length === 0) {
    console.log('No wrong advance logs found. DB is clean.');
    return;
  }

  console.log(`Found ${wrongLogs.length} incorrectly flagged advance logs:`);
  for (const l of wrongLogs) {
    console.log(`  id=${l.id} emp=${l.employeeId} ${l.startDate}→${l.endDate} notes="${l.notes}" finalPay=${l.finalPay}`);
  }

  const result = await prisma.paymentLog.updateMany({
    where: {
      isAdvance: false,
      notes: { startsWith: 'Salary Advance' },
    },
    data: { isAdvance: true },
  });

  console.log(`\nFixed ${result.count} advance logs — isAdvance set to true.`);
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
