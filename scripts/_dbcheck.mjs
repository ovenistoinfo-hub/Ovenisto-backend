// Throwaway diagnostic: which DB does the local .env point at, and what's in it?
// Read-only. Run from Ovenisto-backend/:  node scripts/_dbcheck.mjs
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const url = process.env.DATABASE_URL || '(unset)';
const masked = url.replace(/\/\/([^:]+):[^@]+@/, '//$1:****@');

const [outlets, users, customers, menuItems, menuCats, deals, orders, ingredients] =
  await Promise.all([
    prisma.outlet.count(),
    prisma.user.count(),
    prisma.customer.count(),
    prisma.foodMenuItem.count(),
    prisma.foodCategory.count(),
    prisma.deal.count(),
    prisma.order.count(),
    prisma.ingredient.count(),
  ]);

console.log(
  JSON.stringify(
    {
      host: masked.split('@')[1]?.split('/')[0],
      fullMasked: masked,
      counts: { outlets, users, customers, menuItems, menuCats, deals, orders, ingredients },
    },
    null,
    2,
  ),
);

console.log('outlets:', await prisma.outlet.findMany({ select: { code: true, name: true } }));
console.log(
  'latest 3 customers:',
  await prisma.customer.findMany({
    select: { name: true, createdAt: true },
    orderBy: { createdAt: 'desc' },
    take: 3,
  }),
);

await prisma.$disconnect();
