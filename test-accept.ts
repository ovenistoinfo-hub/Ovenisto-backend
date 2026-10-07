import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function run() {
  const order = await prisma.order.findFirst({ where: { status: 'PENDING' } });
  console.log("Found order:", order?.id);
}
run().catch(console.error).finally(() => prisma.$disconnect());
