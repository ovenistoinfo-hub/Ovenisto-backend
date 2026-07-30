import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  console.log("=== FIXING ZAIN ATTENDANCE & SHIFTS ===");

  const user = await prisma.user.findFirst({
    where: { name: { contains: 'Zain', mode: 'insensitive' } },
  });

  if (!user) {
    console.error("Zain user not found!");
    return;
  }

  const userId = user.id;

  // 1. Update ScheduleShifts for Zain's schedule to match shiftConfig (evening start 16:15)
  const updatedShifts = await prisma.scheduleShift.updateMany({
    where: {
      schedule: { userId },
      shiftType: 'evening',
    },
    data: {
      startTime: '16:15',
      endTime: '01:00',
    },
  });
  console.log(`Updated ${updatedShifts.count} schedule shift rows for Zain to startTime '16:15'`);

  // 2. Correct today's attendance record (2026-07-29) from 'present' to 'halfday'
  const todayRec = await prisma.attendanceRecord.findFirst({
    where: { userId, date: '2026-07-29' },
  });

  if (todayRec) {
    await prisma.attendanceRecord.update({
      where: { id: todayRec.id },
      data: { status: 'halfday' },
    });
    console.log(`Updated attendance record ${todayRec.id} status to 'halfday'`);

    // Increment halfdayUsed in LeaveBalance
    const year = 2026;
    await prisma.leaveBalance.upsert({
      where: { userId_year: { userId, year } },
      update: { halfdayUsed: { increment: 1 } },
      create: { userId, year, halfday: 10, halfdayUsed: 1 },
    });
    console.log(`Updated leave balance halfdayUsed for Zain`);
  } else {
    console.log("No attendance record found for today to update.");
  }
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
