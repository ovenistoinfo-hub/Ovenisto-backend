import 'dotenv/config';
import { PrismaClient, UserRole } from '@prisma/client';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

async function main() {
  console.log('🔍 Checking database connection and current users...');

  const existingUsers = await prisma.user.findMany({
    select: {
      id: true,
      name: true,
      email: true,
      role: true,
      outletId: true,
      status: true,
    },
    orderBy: { createdAt: 'asc' },
  });

  console.log(`Found ${existingUsers.length} existing user(s) in the database:`);
  console.table(existingUsers);

  const defaultPassword = 'password123';
  const managerPin = '1234';

  const passwordHash = await bcrypt.hash(defaultPassword, 10);
  const pinHash = await bcrypt.hash(managerPin, 10);

  // 1. Seed / Upsert Super Admin (chain-wide: outletId = null)
  const superAdminEmail = 'superadmin@ovenisto.com';
  const superAdmin = await prisma.user.upsert({
    where: { email: superAdminEmail },
    update: {
      name: 'Super Admin',
      role: UserRole.SUPER_ADMIN,
      branch: 'Headquarters',
      outletId: null, // Chain-wide
      passwordHash,
      pinHash,
      status: 'active',
    },
    create: {
      name: 'Super Admin',
      email: superAdminEmail,
      role: UserRole.SUPER_ADMIN,
      phone: '03000000000',
      branch: 'Headquarters',
      outletId: null, // Chain-wide
      passwordHash,
      pinHash,
      status: 'active',
    },
  });

  console.log('✅ Super Admin configured:');
  console.log({
    id: superAdmin.id,
    name: superAdmin.name,
    email: superAdmin.email,
    role: superAdmin.role,
    outletId: superAdmin.outletId,
    branch: superAdmin.branch,
    status: superAdmin.status,
  });

  // 2. Also ensure admin@ovenisto.com exists
  const adminEmail = 'admin@ovenisto.com';
  const admin = await prisma.user.upsert({
    where: { email: adminEmail },
    update: {
      name: 'Admin',
      role: UserRole.SUPER_ADMIN,
      passwordHash,
      pinHash,
      status: 'active',
    },
    create: {
      name: 'Admin',
      email: adminEmail,
      role: UserRole.SUPER_ADMIN,
      phone: '03000000001',
      branch: 'Headquarters',
      outletId: null,
      passwordHash,
      pinHash,
      status: 'active',
    },
  });

  console.log('✅ Admin configured:');
  console.log({
    id: admin.id,
    name: admin.name,
    email: admin.email,
    role: admin.role,
    outletId: admin.outletId,
    status: admin.status,
  });

  console.log('\n==========================================');
  console.log('🔑 SUPER ADMIN LOGIN CREDENTIALS READY:');
  console.log('------------------------------------------');
  console.log(`Account 1:`);
  console.log(`  Email:    ${superAdmin.email}`);
  console.log(`  Password: ${defaultPassword}`);
  console.log(`  PIN:      ${managerPin}`);
  console.log(`  Role:     ${superAdmin.role}`);
  console.log(`  Scope:    Chain-wide (outletId: null)`);
  console.log('------------------------------------------');
  console.log(`Account 2:`);
  console.log(`  Email:    ${admin.email}`);
  console.log(`  Password: ${defaultPassword}`);
  console.log(`  PIN:      ${managerPin}`);
  console.log(`  Role:     ${admin.role}`);
  console.log('==========================================\n');
}

main()
  .catch((e) => {
    console.error('❌ Error seeding Super Admin:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
