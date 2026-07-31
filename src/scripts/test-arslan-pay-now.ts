import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const employeeId = 'af7bc189-0625-491a-b056-779e45ac05df'; // Arslan
  const startDate = '2026-07-01';
  const endDate = '2026-07-29';
  const isAdvanceFlag = false;

  console.log('Testing existingDuplicate for Arslan...');
  const existingDuplicate = await prisma.paymentLog.findFirst({
    where: {
      employeeId,
      startDate,
      endDate,
      ...(isAdvanceFlag
        ? {
            OR: [
              { isAdvance: true },
              { notes: { startsWith: 'Salary Advance' } },
            ],
          }
        : {
            isAdvance: false,
            NOT: { notes: { startsWith: 'Salary Advance' } },
          }),
    },
  });

  console.log('existingDuplicate result:', existingDuplicate);

  // Check all logs for Arslan in DB
  const allArslanLogs = await prisma.paymentLog.findMany({
    where: { employeeId },
  });
  console.log('All Arslan logs in DB:', allArslanLogs);
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
