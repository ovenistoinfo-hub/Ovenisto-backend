import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function clearAndReseed() {
  // Delete old users that don't match new mock data
  const oldEmails = ['manager@ovenisto.com', 'cashier@ovenisto.com', 'waiter@ovenisto.com', 'kitchen@ovenisto.com', 'test@ovenisto.com'];
  await prisma.user.deleteMany({ where: { email: { in: oldEmails } } });
  console.log('Cleared old non-matching users');

  // Also update existing admin if name doesn't match
  const admin = await prisma.user.findUnique({ where: { email: 'admin@ovenisto.com' } });
  if (admin && admin.name !== 'Admin User') {
    await prisma.user.update({
      where: { email: 'admin@ovenisto.com' },
      data: { name: 'Admin User', phone: '03201119898', branch: 'Main Branch' },
    });
    console.log('Updated admin user to match mock data');
  }

  await prisma.$disconnect();
  console.log('Done. Now run: npx tsx prisma/seed.ts');
}

clearAndReseed().catch(console.error);
