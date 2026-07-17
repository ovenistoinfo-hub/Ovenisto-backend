/**
 * Prisma Seed Script
 * Seeds initial data from frontend mock data
 *
 * Run with: npm run db:seed
 */

import { PrismaClient, UserRole } from '@prisma/client';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

async function main() {
  console.log('🌱 Starting database seed...');

  // ============================================
  // Create default outlet
  // ============================================
  const outlet = await prisma.outlet.upsert({
    where: { code: 'MAIN' },
    update: {},
    create: {
      name: 'Ovenisto Main Branch',
      code: 'MAIN',
      address: '123 Main Street',
      city: 'Karachi',
      phone: '021-1234567',
      email: 'main@ovenisto.com',
      isActive: true,
    },
  });
  console.log('✅ Created outlet:', outlet.name);

  // ============================================
  // Create default users (from mock-data.ts)
  // ============================================
  const defaultPassword = await bcrypt.hash('password123', 10);

  const users = [
    {
      name: 'Admin User',
      email: 'admin@ovenisto.com',
      role: UserRole.SUPER_ADMIN,
      phone: '03201119898',
      branch: 'Main Branch',
    },
    {
      name: 'Ali Hassan',
      email: 'ali@ovenisto.com',
      role: UserRole.MANAGER,
      phone: '03001234567',
      branch: 'Main Branch',
    },
    {
      name: 'Ahmed Khan',
      email: 'ahmed@ovenisto.com',
      role: UserRole.CASHIER,
      phone: '03009876543',
      branch: 'Main Branch',
    },
    {
      name: 'Usman Raza',
      email: 'usman@ovenisto.com',
      role: UserRole.KITCHEN,
      phone: '03005556789',
      branch: 'Main Branch',
    },
    {
      name: 'Bilal Sheikh',
      email: 'bilal@ovenisto.com',
      role: UserRole.WAITER,
      phone: '03001112233',
      branch: 'Main Branch',
    },
    {
      name: 'Faisal Iqbal',
      email: 'faisal@ovenisto.com',
      role: UserRole.WAITER,
      phone: '03214567890',
      branch: 'Main Branch',
    },
    {
      name: 'Hassan Raza',
      email: 'hassan@ovenisto.com',
      role: UserRole.WAITER,
      phone: '03331234560',
      branch: 'Main Branch',
    },
    // New roles
    {
      name: 'Branch Admin',
      email: 'branchadmin@ovenisto.com',
      role: UserRole.ADMIN,
      phone: '03111234567',
      branch: 'Main Branch',
    },
    {
      name: 'Tariq Mehmood',
      email: 'tariq@ovenisto.com',
      role: UserRole.KITCHEN_MANAGER,
      phone: '03451234567',
      branch: 'Main Branch',
    },
    {
      name: 'Saad Malik',
      email: 'saad@ovenisto.com',
      role: UserRole.FLOOR_MANAGER,
      phone: '03461234567',
      branch: 'Main Branch',
    },
    {
      name: 'Kamran Ali',
      email: 'kamran@ovenisto.com',
      role: UserRole.DELIVERY_MANAGER,
      phone: '03471234567',
      branch: 'Main Branch',
    },
    {
      name: 'Waqas Ahmed',
      email: 'waqas@ovenisto.com',
      role: UserRole.STORE_MANAGER,
      phone: '03481234567',
      branch: 'Main Branch',
    },
    {
      name: 'Zeeshan Haider',
      email: 'zeeshan@ovenisto.com',
      role: UserRole.ACCOUNTANT,
      phone: '03491234567',
      branch: 'Main Branch',
    },
    {
      name: 'Imran Rider',
      email: 'imran@ovenisto.com',
      role: UserRole.RIDER,
      phone: '03501234567',
      branch: 'Main Branch',
    },
    {
      name: 'Customer Display',
      email: 'display@ovenisto.com',
      role: UserRole.CUSTOMER_SCREEN,
      phone: null,
      branch: 'Main Branch',
    },
  ];

  for (const userData of users) {
    const user = await prisma.user.upsert({
      where: { email: userData.email },
      update: {},
      create: {
        ...userData,
        passwordHash: defaultPassword,
        outletId: outlet.id,
        status: 'active',
      },
    });
    console.log(`✅ Created user: ${user.name} (${user.role})`);
  }

  // ============================================
  // Create default settings
  // ============================================
  await prisma.settings.create({
    data: {
      outletId: outlet.id,
      restaurantName: 'Ovenisto - Flame Kissed Flavor',
      currency: 'Rs.',
      taxRate: 16,
      taxName: 'GST',
      phone: '021-1234567',
      email: 'info@ovenisto.com',
      address: '123 Main Street, Karachi',
      receiptHeader: 'Thank you for dining with us!',
      tableManagement: true,
      onlineOrders: true,
      reservations: true,
    },
  });
  console.log('✅ Created default settings');

  // ============================================
  // Create sample food categories
  // ============================================
  const categories = [
    { name: 'Pizza', displayOrder: 1 },
    { name: 'Burgers', displayOrder: 2 },
    { name: 'Pasta', displayOrder: 3 },
    { name: 'Appetizers', displayOrder: 4 },
    { name: 'Beverages', displayOrder: 5 },
    { name: 'Desserts', displayOrder: 6 },
  ];

  for (const cat of categories) {
    await prisma.foodCategory.create({ data: cat });
  }
  console.log('✅ Created food categories');

  // ============================================
  // Create ingredient units
  // ============================================
  const units = ['kg', 'g', 'L', 'ml', 'pcs', 'dozen', 'box', 'pack'];
  for (const unit of units) {
    await prisma.ingredientUnit.create({ data: { name: unit } });
  }
  console.log('✅ Created ingredient units');

  // ============================================
  // Create ingredient categories
  // ============================================
  const ingredientCategories = [
    { name: 'Dairy', description: 'Milk, cheese, butter, etc.' },
    { name: 'Vegetables', description: 'Fresh vegetables' },
    { name: 'Meat', description: 'Chicken, beef, etc.' },
    { name: 'Spices', description: 'Spices and seasonings' },
    { name: 'Grains', description: 'Flour, rice, etc.' },
    { name: 'Sauces', description: 'Sauces and condiments' },
  ];

  for (const cat of ingredientCategories) {
    await prisma.ingredientCategory.create({ data: cat });
  }
  console.log('✅ Created ingredient categories');

  // ============================================
  // Create default kitchen
  // ============================================
  await prisma.kitchen.create({
    data: {
      name: 'Main Kitchen',
      assignedCategories: ['Pizza', 'Burgers', 'Pasta', 'Appetizers'],
      status: 'active',
    },
  });
  console.log('✅ Created default kitchen');

  // ============================================
  // Create loyalty settings
  // ============================================
  await prisma.loyaltySettings.create({
    data: {
      outletId: outlet.id,
      pointsPerAmount: 1,
      amountPerPoint: 100,
      signupBonus: 100,
      birthdayBonus: 50,
      tiers: [
        { name: 'Bronze', minPoints: 0, discount: 0 },
        { name: 'Silver', minPoints: 500, discount: 5 },
        { name: 'Gold', minPoints: 1000, discount: 10 },
        { name: 'Platinum', minPoints: 2500, discount: 15 },
      ],
    },
  });
  console.log('✅ Created loyalty settings');

  console.log('\n🎉 Database seeded successfully!');
  console.log('\nDefault login credentials:');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('Email: admin@ovenisto.com');
  console.log('Password: password123');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
}

main()
  .catch((e) => {
    console.error('❌ Seed error:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
