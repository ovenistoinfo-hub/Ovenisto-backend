import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  console.log("=== INSPECTING ZAIN & ATTENDANCE SETTINGS ===");

  // 1. Find user or employee named Zain
  const users = await prisma.user.findMany({
    where: { name: { contains: 'Zain', mode: 'insensitive' } },
  });
  console.log("Found Users:", JSON.stringify(users, null, 2));

  if (users.length === 0) {
    console.log("No user found with name Zain");
    return;
  }

  const userId = users[0].id;

  // 2. Fetch Settings
  const settings = await prisma.settings.findMany();
  console.log("Settings in DB:", JSON.stringify(settings, null, 2));

  // 3. Fetch Staff Schedule for Zain
  const schedules = await prisma.staffSchedule.findMany({
    where: { userId },
    include: { shifts: true },
    orderBy: { weekStart: 'desc' },
  });
  console.log("Zain's Schedules:", JSON.stringify(schedules, null, 2));

  // 4. Fetch Attendance Records for Zain
  const attendance = await prisma.attendanceRecord.findMany({
    where: { userId },
    orderBy: { date: 'desc' },
    take: 10,
  });
  console.log("Zain's Recent Attendance Records:", JSON.stringify(attendance, null, 2));

  // 5. Fetch Leave Balance for Zain
  const leaveBalances = await prisma.leaveBalance.findMany({
    where: { userId },
  });
  console.log("Zain's Leave Balances:", JSON.stringify(leaveBalances, null, 2));
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
