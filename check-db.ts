import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function check() {
  try {
    const users = await prisma.user.count();
    const outlets = await prisma.outlet.count();
    const settings = await prisma.settings.count();
    const categories = await prisma.foodCategory.count();
    const units = await prisma.ingredientUnit.count();

    console.log('=== Database Status ===');
    console.log('Connection: OK');
    console.log('Users:', users);
    console.log('Outlets:', outlets);
    console.log('Settings:', settings);
    console.log('Food Categories:', categories);
    console.log('Ingredient Units:', units);

    if (users === 0 && outlets === 0) {
      console.log('\nTables exist but are EMPTY - run: npm run db:seed');
    } else {
      console.log('\nDatabase is seeded with data!');
    }
  } catch (e: any) {
    if (e.message.includes('does not exist')) {
      console.log('Tables NOT created yet - run: npm run db:push');
    } else {
      console.log('ERROR:', e.message);
    }
  } finally {
    await prisma.$disconnect();
  }
}

check();
