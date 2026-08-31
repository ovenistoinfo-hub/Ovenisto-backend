/**
 * Prisma Seed Script
 * Seeds initial data from frontend mock data
 *
 * Run with: npm run db:seed
 */

import { PrismaClient, UserRole, WarehouseType, DealType, BogoRole } from '@prisma/client';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

async function main() {
  console.log('🌱 Starting comprehensive database seed for Ovenisto...');

  // ============================================
  // 1. OUTLET (Branch)
  // ============================================
  const outlet = await prisma.outlet.upsert({
    where: { code: 'OVENISTO' },
    update: {
      name: 'Ovenisto',
      address: 'Shop # 4-5, Block B, Commercial Area, Clifton',
      city: 'Karachi',
      phone: '021-35889900',
      email: 'info@ovenisto.com',
      isActive: true,
    },
    create: {
      name: 'Ovenisto',
      code: 'OVENISTO',
      address: 'Shop # 4-5, Block B, Commercial Area, Clifton',
      city: 'Karachi',
      phone: '021-35889900',
      email: 'info@ovenisto.com',
      isActive: true,
    },
  });
  console.log(`✅ Outlet ready: ${outlet.name} (Code: ${outlet.code})`);

  // ============================================
  // 2. SETTINGS
  // ============================================
  await prisma.settings.deleteMany({ where: { outletId: outlet.id } });
  await prisma.settings.create({
    data: {
      outletId: outlet.id,
      restaurantName: 'Ovenisto - Flame Kissed Flavor',
      currency: 'Rs.',
      taxRate: 16,
      taxName: 'GST',
      phone: '021-35889900',
      email: 'info@ovenisto.com',
      address: 'Shop # 4-5, Block B, Commercial Area, Clifton, Karachi',
      receiptHeader: 'Thank you for dining at Ovenisto — Flame Kissed Flavor!',
      tableManagement: true,
      onlineOrders: true,
      reservations: true,
      paymentMethods: ['Cash', 'Credit Card', 'Debit Card', 'JazzCash', 'EasyPaisa', 'Bank Transfer'],
      graceMinutes: 15,
      selfOrderConfig: { enabled: true, requirePhone: true },
      websiteConfig: { deliveryFee: 150, minOrder: 500 },
      reservationConfig: { depositRequired: false },
      shiftConfig: { autoCloseHours: 12 },
    },
  });
  console.log('✅ Created settings with dynamic payment methods');

  // ============================================
  // 3. USERS & PASSWORDS
  // ============================================
  const defaultPassword = await bcrypt.hash('password123', 10);
  const managerPin = await bcrypt.hash('1234', 10);

  const usersData = [
    {
      name: 'Super Admin',
      email: 'superadmin@ovenisto.com',
      role: UserRole.SUPER_ADMIN,
      phone: '03000000000',
      branch: 'Headquarters',
      outletId: null,
      pinHash: managerPin,
    },
    {
      name: 'Admin',
      email: 'admin@ovenisto.com',
      role: UserRole.SUPER_ADMIN,
      phone: '03000000001',
      branch: 'Ovenisto',
      outletId: outlet.id,
      pinHash: managerPin,
    },
    {
      name: 'Branch Admin',
      email: 'branchadmin@ovenisto.com',
      role: UserRole.ADMIN,
      phone: '03001111111',
      branch: 'Ovenisto',
      outletId: outlet.id,
      pinHash: managerPin,
    },
    {
      name: 'Ali Raza (Manager)',
      email: 'manager@ovenisto.com',
      role: UserRole.MANAGER,
      phone: '03002222222',
      branch: 'Ovenisto',
      outletId: outlet.id,
      pinHash: managerPin,
    },
    {
      name: 'Ahmed Khan (Cashier)',
      email: 'cashier@ovenisto.com',
      role: UserRole.CASHIER,
      phone: '03003333333',
      branch: 'Ovenisto',
      outletId: outlet.id,
      pinHash: null,
    },
    {
      name: 'Bilal Sheikh (Waiter)',
      email: 'waiter1@ovenisto.com',
      role: UserRole.WAITER,
      phone: '03004444444',
      branch: 'Ovenisto',
      outletId: outlet.id,
      pinHash: null,
    },
    {
      name: 'Hamza Tariq (Waiter)',
      email: 'waiter2@ovenisto.com',
      role: UserRole.WAITER,
      phone: '03005555555',
      branch: 'Ovenisto',
      outletId: outlet.id,
      pinHash: null,
    },
    {
      name: 'Usman Chef (Kitchen)',
      email: 'kitchen@ovenisto.com',
      role: UserRole.KITCHEN,
      phone: '03006666666',
      branch: 'Ovenisto',
      outletId: outlet.id,
      pinHash: null,
    },
    {
      name: 'Tariq Head Chef',
      email: 'kitchenmanager@ovenisto.com',
      role: UserRole.KITCHEN_MANAGER,
      phone: '03007777777',
      branch: 'Ovenisto',
      outletId: outlet.id,
      pinHash: null,
    },
    {
      name: 'Saad Floor Manager',
      email: 'floormanager@ovenisto.com',
      role: UserRole.FLOOR_MANAGER,
      phone: '03008888888',
      branch: 'Ovenisto',
      outletId: outlet.id,
      pinHash: managerPin,
    },
    {
      name: 'Kamran Delivery Manager',
      email: 'deliverymanager@ovenisto.com',
      role: UserRole.DELIVERY_MANAGER,
      phone: '03009999999',
      branch: 'Ovenisto',
      outletId: outlet.id,
      pinHash: null,
    },
    {
      name: 'Waqas Store Manager',
      email: 'storemanager@ovenisto.com',
      role: UserRole.STORE_MANAGER,
      phone: '03011223344',
      branch: 'Ovenisto',
      outletId: outlet.id,
      pinHash: null,
    },
    {
      name: 'Zeeshan Accountant',
      email: 'accountant@ovenisto.com',
      role: UserRole.ACCOUNTANT,
      phone: '03022334455',
      branch: 'Ovenisto',
      outletId: outlet.id,
      pinHash: null,
    },
    {
      name: 'Imran Rider',
      email: 'rider1@ovenisto.com',
      role: UserRole.RIDER,
      phone: '03033445566',
      branch: 'Ovenisto',
      outletId: outlet.id,
      pinHash: null,
    },
    {
      name: 'Kashif Rider',
      email: 'rider2@ovenisto.com',
      role: UserRole.RIDER,
      phone: '03044556677',
      branch: 'Ovenisto',
      outletId: outlet.id,
      pinHash: null,
    },
    {
      name: 'Customer Screen Display',
      email: 'display@ovenisto.com',
      role: UserRole.CUSTOMER_SCREEN,
      phone: null,
      branch: 'Ovenisto',
      outletId: outlet.id,
      pinHash: null,
    },
  ];

  const userMap = new Map<string, any>();
  for (const u of usersData) {
    const user = await prisma.user.upsert({
      where: { email: u.email },
      update: {
        name: u.name,
        role: u.role,
        phone: u.phone,
        branch: u.branch,
        outletId: u.outletId,
        passwordHash: defaultPassword,
        pinHash: u.pinHash,
        status: 'active',
      },
      create: {
        name: u.name,
        email: u.email,
        role: u.role,
        phone: u.phone,
        branch: u.branch,
        outletId: u.outletId,
        passwordHash: defaultPassword,
        pinHash: u.pinHash,
        status: 'active',
      },
    });
    userMap.set(u.email, user);
    console.log(`✅ User configured: ${user.email} (${user.role})`);
  }

  // ============================================
  // 4. DELIVERY RIDERS PROFILES
  // ============================================
  const rider1User = userMap.get('rider1@ovenisto.com');
  if (rider1User) {
    await prisma.deliveryRider.upsert({
      where: { userId: rider1User.id },
      update: { name: 'Imran Rider', phone: '03033445566', status: 'available', isAvailable: true },
      create: {
        userId: rider1User.id,
        name: 'Imran Rider',
        phone: '03033445566',
        status: 'available',
        isAvailable: true,
      },
    });
  }

  const rider2User = userMap.get('rider2@ovenisto.com');
  if (rider2User) {
    await prisma.deliveryRider.upsert({
      where: { userId: rider2User.id },
      update: { name: 'Kashif Rider', phone: '03044556677', status: 'available', isAvailable: true },
      create: {
        userId: rider2User.id,
        name: 'Kashif Rider',
        phone: '03044556677',
        status: 'available',
        isAvailable: true,
      },
    });
  }
  console.log('✅ Delivery rider profiles created');

  // ============================================
  // 5. EMPLOYEES (HR Profiles)
  // ============================================
  const employeesData = [
    {
      userId: userMap.get('branchadmin@ovenisto.com')?.id,
      firstName: 'Branch',
      lastName: 'Admin',
      email: 'branchadmin@ovenisto.com',
      phone: '03001111111',
      division: 'Management',
      designation: 'Branch Administrator',
      dutyType: 'Full Time',
      rateType: 'Monthly',
      rate: 90000,
      hireDate: new Date('2024-01-01'),
    },
    {
      userId: userMap.get('manager@ovenisto.com')?.id,
      firstName: 'Ali',
      lastName: 'Raza',
      email: 'manager@ovenisto.com',
      phone: '03002222222',
      division: 'Operations',
      designation: 'General Restaurant Manager',
      dutyType: 'Full Time',
      rateType: 'Monthly',
      rate: 75000,
      hireDate: new Date('2024-01-15'),
    },
    {
      userId: userMap.get('cashier@ovenisto.com')?.id,
      firstName: 'Ahmed',
      lastName: 'Khan',
      email: 'cashier@ovenisto.com',
      phone: '03003333333',
      division: 'Accounts & Cash',
      designation: 'Head Cashier',
      dutyType: 'Full Time',
      rateType: 'Monthly',
      rate: 40000,
      hireDate: new Date('2024-02-01'),
    },
    {
      userId: userMap.get('kitchenmanager@ovenisto.com')?.id,
      firstName: 'Tariq',
      lastName: 'Mehmood',
      email: 'kitchenmanager@ovenisto.com',
      phone: '03007777777',
      division: 'Kitchen',
      designation: 'Executive Head Chef',
      dutyType: 'Full Time',
      rateType: 'Monthly',
      rate: 80000,
      hireDate: new Date('2024-01-10'),
    },
    {
      userId: userMap.get('kitchen@ovenisto.com')?.id,
      firstName: 'Usman',
      lastName: 'Raza',
      email: 'kitchen@ovenisto.com',
      phone: '03006666666',
      division: 'Kitchen',
      designation: 'Senior Line Chef',
      dutyType: 'Full Time',
      rateType: 'Monthly',
      rate: 50000,
      hireDate: new Date('2024-02-15'),
    },
    {
      userId: userMap.get('waiter1@ovenisto.com')?.id,
      firstName: 'Bilal',
      lastName: 'Sheikh',
      email: 'waiter1@ovenisto.com',
      phone: '03004444444',
      division: 'Dining Service',
      designation: 'Captain Waiter',
      dutyType: 'Full Time',
      rateType: 'Monthly',
      rate: 35000,
      hireDate: new Date('2024-03-01'),
    },
    {
      userId: userMap.get('waiter2@ovenisto.com')?.id,
      firstName: 'Hamza',
      lastName: 'Tariq',
      email: 'waiter2@ovenisto.com',
      phone: '03005555555',
      division: 'Dining Service',
      designation: 'Floor Waiter',
      dutyType: 'Full Time',
      rateType: 'Monthly',
      rate: 30000,
      hireDate: new Date('2024-03-15'),
    },
    {
      userId: userMap.get('rider1@ovenisto.com')?.id,
      firstName: 'Imran',
      lastName: 'Rider',
      email: 'rider1@ovenisto.com',
      phone: '03033445566',
      division: 'Delivery Logistics',
      designation: 'Senior Delivery Rider',
      dutyType: 'Full Time',
      rateType: 'Monthly',
      rate: 32000,
      hireDate: new Date('2024-03-01'),
    },
    {
      userId: userMap.get('storemanager@ovenisto.com')?.id,
      firstName: 'Waqas',
      lastName: 'Ahmed',
      email: 'storemanager@ovenisto.com',
      phone: '03011223344',
      division: 'Warehouse & Inventory',
      designation: 'Inventory Store Keeper',
      dutyType: 'Full Time',
      rateType: 'Monthly',
      rate: 45000,
      hireDate: new Date('2024-02-01'),
    },
  ];

  for (const emp of employeesData) {
    if (emp.userId) {
      await prisma.employee.upsert({
        where: { userId: emp.userId },
        update: {
          firstName: emp.firstName,
          lastName: emp.lastName,
          email: emp.email,
          phone: emp.phone,
          division: emp.division,
          designation: emp.designation,
          dutyType: emp.dutyType,
          rateType: emp.rateType,
          rate: emp.rate,
          outletId: outlet.id,
          status: 'active',
        },
        create: {
          userId: emp.userId,
          outletId: outlet.id,
          firstName: emp.firstName,
          lastName: emp.lastName,
          email: emp.email,
          phone: emp.phone,
          division: emp.division,
          designation: emp.designation,
          dutyType: emp.dutyType,
          rateType: emp.rateType,
          rate: emp.rate,
          hireDate: emp.hireDate,
          status: 'active',
        },
      });
    }
  }
  console.log('✅ Created HR Employee profiles linked to users');

  // ============================================
  // 6. WAREHOUSES
  // ============================================
  const mainWarehouse = await prisma.warehouse.upsert({
    where: { code: 'WH-MAIN' },
    update: { name: 'Main Central Logistics Hub', address: 'Central Warehouse Complex, Karachi' },
    create: {
      name: 'Main Central Logistics Hub',
      code: 'WH-MAIN',
      address: 'Central Warehouse Complex, Karachi',
      type: WarehouseType.MAIN,
      outletId: null,
      managerId: userMap.get('storemanager@ovenisto.com')?.id,
      isActive: true,
    },
  });

  const branchWarehouse = await prisma.warehouse.upsert({
    where: { code: 'WH-BR-OVENISTO' },
    update: { name: 'Ovenisto Branch Warehouse', address: 'Ovenisto Branch Backstore' },
    create: {
      name: 'Ovenisto Branch Warehouse',
      code: 'WH-BR-OVENISTO',
      address: 'Ovenisto Branch Backstore',
      type: WarehouseType.BRANCH,
      outletId: outlet.id,
      managerId: userMap.get('manager@ovenisto.com')?.id,
      isActive: true,
    },
  });

  const kitchenWarehouse = await prisma.warehouse.upsert({
    where: { code: 'WH-KT-OVENISTO' },
    update: { name: 'Ovenisto Kitchen Warehouse', address: 'Ovenisto Kitchen Prep Line' },
    create: {
      name: 'Ovenisto Kitchen Warehouse',
      code: 'WH-KT-OVENISTO',
      address: 'Ovenisto Kitchen Prep Line',
      type: WarehouseType.KITCHEN,
      outletId: outlet.id,
      managerId: userMap.get('kitchenmanager@ovenisto.com')?.id,
      isActive: true,
    },
  });
  console.log('✅ Created Main, Branch, and Kitchen Warehouses');

  // ============================================
  // 7. SUPPLIERS (Vendors)
  // ============================================
  const suppliersData = [
    {
      name: 'Fresh Farms Poultry',
      company: 'Fresh Farms Poultry Ltd',
      phone: '03009988771',
      email: 'poultry@freshfarms.pk',
    },
    {
      name: 'Noor Dairy & Cheese',
      company: 'Noor Dairy Products',
      phone: '03009988772',
      email: 'sales@noordairy.pk',
    },
    {
      name: 'Mandi Wholesale Produce',
      company: 'Sabzi Mandi Direct Traders',
      phone: '03009988773',
      email: 'supplies@manditraders.pk',
    },
    {
      name: 'Dawn Bakeries & Flour',
      company: 'Dawn Bread Wholesale',
      phone: '03009988774',
      email: 'b2b@dawnbakery.pk',
    },
    {
      name: 'Sindh Beverage Distro',
      company: 'Sindh Beverage Distributors',
      phone: '03009988775',
      email: 'coke@sindhbev.pk',
    },
    {
      name: 'National Spices & Packaging',
      company: 'National Spices Packaging Co',
      phone: '03009988776',
      email: 'info@nationalspices.pk',
    },
  ];

  const supplierMap = new Map<string, any>();
  for (const s of suppliersData) {
    let supplier = await prisma.supplier.findFirst({ where: { name: s.name } });
    if (!supplier) {
      supplier = await prisma.supplier.create({
        data: {
          name: s.name,
          company: s.company,
          phone: s.phone,
          email: s.email,
          outletId: outlet.id,
        },
      });
    }
    supplierMap.set(s.name, supplier);
  }
  console.log('✅ Created suppliers / vendors');

  // ============================================
  // 8. INGREDIENT UNITS & CONVERSIONS
  // ============================================
  const unitsData = [
    { name: 'Kilogram', symbol: 'kg' },
    { name: 'Gram', symbol: 'g' },
    { name: 'Liter', symbol: 'L' },
    { name: 'Milliliter', symbol: 'ml' },
    { name: 'Piece', symbol: 'pcs' },
    { name: 'Dozen', symbol: 'dz' },
    { name: 'Pack', symbol: 'pack' },
    { name: 'Box', symbol: 'box' },
    { name: 'Portion', symbol: 'portion' },
  ];

  const unitMap = new Map<string, string>();
  for (const u of unitsData) {
    let unit = await prisma.ingredientUnit.findFirst({ where: { symbol: u.symbol } });
    if (!unit) {
      unit = await prisma.ingredientUnit.create({
        data: { name: u.name, symbol: u.symbol },
      });
    }
    unitMap.set(u.symbol, unit.id);
  }

  // Conversions
  const kgId = unitMap.get('kg')!;
  const gId = unitMap.get('g')!;
  const lId = unitMap.get('L')!;
  const mlId = unitMap.get('ml')!;
  const dzId = unitMap.get('dz')!;
  const pcsId = unitMap.get('pcs')!;

  const conversions = [
    { fromUnitId: kgId, toUnitId: gId, factor: 1000 },
    { fromUnitId: gId, toUnitId: kgId, factor: 0.001 },
    { fromUnitId: lId, toUnitId: mlId, factor: 1000 },
    { fromUnitId: mlId, toUnitId: lId, factor: 0.001 },
    { fromUnitId: dzId, toUnitId: pcsId, factor: 12 },
    { fromUnitId: pcsId, toUnitId: dzId, factor: 0.08333333 },
  ];

  for (const c of conversions) {
    await prisma.unitConversion.upsert({
      where: { fromUnitId_toUnitId: { fromUnitId: c.fromUnitId, toUnitId: c.toUnitId } },
      update: { factor: c.factor },
      create: c,
    });
  }
  console.log('✅ Created units and unit conversions');

  // ============================================
  // 9. INGREDIENT CATEGORIES & INGREDIENTS
  // ============================================
  const ingCatData = [
    { name: 'Meat & Poultry', description: 'Chicken, beef patties, mince' },
    { name: 'Dairy & Cheese', description: 'Mozzarella, cheddar, butter, cream' },
    { name: 'Fresh Vegetables', description: 'Tomatoes, onions, capsicum, olives, mushrooms' },
    { name: 'Bakery & Dough', description: 'Pizza dough, burger buns, pasta' },
    { name: 'Sauces & Condiments', description: 'Pizza sauce, mayo, garlic sauce, BBQ sauce' },
    { name: 'Spices & Seasonings', description: 'Tikka masala, salt, pepper, chilli flakes' },
    { name: 'Beverages & Soft Drinks', description: 'Coke, Sprite, Water bottles' },
    { name: 'Desserts & Sweet Mix', description: 'Lava cake mix, ice cream, chocolate' },
  ];

  const ingCatMap = new Map<string, string>();
  for (const cat of ingCatData) {
    let createdCat = await prisma.ingredientCategory.findFirst({ where: { name: cat.name } });
    if (!createdCat) {
      createdCat = await prisma.ingredientCategory.create({ data: cat });
    }
    ingCatMap.set(cat.name, createdCat.id);
  }

  const rawIngredients = [
    {
      name: 'Chicken Breast Fillet',
      brand: 'Fresh Farms',
      catName: 'Meat & Poultry',
      unitSymbol: 'kg',
      price: 850,
      lowStock: 20,
      supplierName: 'Fresh Farms Poultry',
      mainStock: 150,
      branchStock: 40,
      kitchenStock: 15,
    },
    {
      name: 'Beef Burger Patty',
      brand: 'K&N’s Commercial',
      catName: 'Meat & Poultry',
      unitSymbol: 'pcs',
      price: 180,
      lowStock: 50,
      supplierName: 'Fresh Farms Poultry',
      mainStock: 300,
      branchStock: 100,
      kitchenStock: 40,
    },
    {
      name: 'Mozzarella Cheese Block',
      brand: 'Olper’s Commercial',
      catName: 'Dairy & Cheese',
      unitSymbol: 'kg',
      price: 1400,
      lowStock: 15,
      supplierName: 'Noor Dairy & Cheese',
      mainStock: 100,
      branchStock: 30,
      kitchenStock: 12,
    },
    {
      name: 'Cheddar Cheese Slices',
      brand: 'Noor Dairy',
      catName: 'Dairy & Cheese',
      unitSymbol: 'pcs',
      price: 25,
      lowStock: 100,
      supplierName: 'Noor Dairy & Cheese',
      mainStock: 500,
      branchStock: 200,
      kitchenStock: 80,
    },
    {
      name: 'Heavy Cooking Cream',
      brand: 'Nurpur',
      catName: 'Dairy & Cheese',
      unitSymbol: 'L',
      price: 650,
      lowStock: 10,
      supplierName: 'Noor Dairy & Cheese',
      mainStock: 80,
      branchStock: 20,
      kitchenStock: 8,
    },
    {
      name: 'Butter Unsalted',
      brand: 'Nurpur',
      catName: 'Dairy & Cheese',
      unitSymbol: 'kg',
      price: 1100,
      lowStock: 10,
      supplierName: 'Noor Dairy & Cheese',
      mainStock: 60,
      branchStock: 15,
      kitchenStock: 5,
    },
    {
      name: 'Fresh Tomatoes',
      brand: 'Mandi Produce',
      catName: 'Fresh Vegetables',
      unitSymbol: 'kg',
      price: 120,
      lowStock: 20,
      supplierName: 'Mandi Wholesale Produce',
      mainStock: 80,
      branchStock: 30,
      kitchenStock: 15,
    },
    {
      name: 'Fresh Red Onions',
      brand: 'Mandi Produce',
      catName: 'Fresh Vegetables',
      unitSymbol: 'kg',
      price: 90,
      lowStock: 20,
      supplierName: 'Mandi Wholesale Produce',
      mainStock: 100,
      branchStock: 40,
      kitchenStock: 20,
    },
    {
      name: 'Capsicum Green',
      brand: 'Mandi Produce',
      catName: 'Fresh Vegetables',
      unitSymbol: 'kg',
      price: 160,
      lowStock: 15,
      supplierName: 'Mandi Wholesale Produce',
      mainStock: 50,
      branchStock: 20,
      kitchenStock: 10,
    },
    {
      name: 'Black Sliced Olives',
      brand: 'Campagna',
      catName: 'Fresh Vegetables',
      unitSymbol: 'kg',
      price: 950,
      lowStock: 5,
      supplierName: 'National Spices & Packaging',
      mainStock: 40,
      branchStock: 15,
      kitchenStock: 6,
    },
    {
      name: 'Mushroom Slices (Canned)',
      brand: 'Ligo',
      catName: 'Fresh Vegetables',
      unitSymbol: 'kg',
      price: 750,
      lowStock: 5,
      supplierName: 'National Spices & Packaging',
      mainStock: 40,
      branchStock: 15,
      kitchenStock: 6,
    },
    {
      name: 'Jalapeno Pepper Slices',
      brand: 'Ligo',
      catName: 'Fresh Vegetables',
      unitSymbol: 'kg',
      price: 680,
      lowStock: 5,
      supplierName: 'National Spices & Packaging',
      mainStock: 40,
      branchStock: 15,
      kitchenStock: 6,
    },
    {
      name: 'French Fries Cut Potatoes',
      brand: 'Dawn Frozen',
      catName: 'Fresh Vegetables',
      unitSymbol: 'kg',
      price: 320,
      lowStock: 30,
      supplierName: 'Dawn Bakeries & Flour',
      mainStock: 200,
      branchStock: 80,
      kitchenStock: 35,
    },
    {
      name: 'Pizza Dough Flour',
      brand: 'Dawn Fine Flour',
      catName: 'Bakery & Dough',
      unitSymbol: 'kg',
      price: 150,
      lowStock: 50,
      supplierName: 'Dawn Bakeries & Flour',
      mainStock: 300,
      branchStock: 100,
      kitchenStock: 40,
    },
    {
      name: 'Gourmet Burger Buns',
      brand: 'Dawn Artisan Buns',
      catName: 'Bakery & Dough',
      unitSymbol: 'pcs',
      price: 45,
      lowStock: 80,
      supplierName: 'Dawn Bakeries & Flour',
      mainStock: 400,
      branchStock: 150,
      kitchenStock: 60,
    },
    {
      name: 'Garlic Bread Baguette',
      brand: 'Dawn Bakery',
      catName: 'Bakery & Dough',
      unitSymbol: 'pcs',
      price: 90,
      lowStock: 30,
      supplierName: 'Dawn Bakeries & Flour',
      mainStock: 150,
      branchStock: 50,
      kitchenStock: 20,
    },
    {
      name: 'Fettuccine Pasta',
      brand: 'Kolson Pasta',
      catName: 'Bakery & Dough',
      unitSymbol: 'kg',
      price: 420,
      lowStock: 10,
      supplierName: 'National Spices & Packaging',
      mainStock: 60,
      branchStock: 25,
      kitchenStock: 10,
    },
    {
      name: 'Penne Pasta',
      brand: 'Kolson Pasta',
      catName: 'Bakery & Dough',
      unitSymbol: 'kg',
      price: 400,
      lowStock: 10,
      supplierName: 'National Spices & Packaging',
      mainStock: 60,
      branchStock: 25,
      kitchenStock: 10,
    },
    {
      name: 'Ovenisto Pizza Red Sauce',
      brand: 'In-House Blend',
      catName: 'Sauces & Condiments',
      unitSymbol: 'kg',
      price: 450,
      lowStock: 15,
      supplierName: 'National Spices & Packaging',
      mainStock: 80,
      branchStock: 30,
      kitchenStock: 15,
    },
    {
      name: 'Garlic Mayo Sauce',
      brand: 'Young’s Commercial',
      catName: 'Sauces & Condiments',
      unitSymbol: 'kg',
      price: 520,
      lowStock: 15,
      supplierName: 'National Spices & Packaging',
      mainStock: 80,
      branchStock: 30,
      kitchenStock: 12,
    },
    {
      name: 'Smoky BBQ Sauce',
      brand: 'Shangrila',
      catName: 'Sauces & Condiments',
      unitSymbol: 'kg',
      price: 550,
      lowStock: 10,
      supplierName: 'National Spices & Packaging',
      mainStock: 50,
      branchStock: 20,
      kitchenStock: 8,
    },
    {
      name: 'Cooking Oil',
      brand: 'Dalda Supreme',
      catName: 'Sauces & Condiments',
      unitSymbol: 'L',
      price: 580,
      lowStock: 30,
      supplierName: 'National Spices & Packaging',
      mainStock: 200,
      branchStock: 70,
      kitchenStock: 25,
    },
    {
      name: 'Coca Cola 500ml Pet',
      brand: 'Coca Cola',
      catName: 'Beverages & Soft Drinks',
      unitSymbol: 'pcs',
      price: 70,
      lowStock: 50,
      supplierName: 'Sindh Beverage Distro',
      mainStock: 500,
      branchStock: 200,
      kitchenStock: 80,
    },
    {
      name: 'Sprite 500ml Pet',
      brand: 'Coca Cola',
      catName: 'Beverages & Soft Drinks',
      unitSymbol: 'pcs',
      price: 70,
      lowStock: 50,
      supplierName: 'Sindh Beverage Distro',
      mainStock: 500,
      branchStock: 200,
      kitchenStock: 80,
    },
    {
      name: 'Mineral Water 500ml',
      brand: 'Aquafina',
      catName: 'Beverages & Soft Drinks',
      unitSymbol: 'pcs',
      price: 35,
      lowStock: 50,
      supplierName: 'Sindh Beverage Distro',
      mainStock: 400,
      branchStock: 150,
      kitchenStock: 60,
    },
    {
      name: 'Choco Lava Cake Portion',
      brand: 'In-House Dessert',
      catName: 'Desserts & Sweet Mix',
      unitSymbol: 'pcs',
      price: 180,
      lowStock: 20,
      supplierName: 'Dawn Bakeries & Flour',
      mainStock: 100,
      branchStock: 40,
      kitchenStock: 20,
    },
    {
      name: 'Vanilla Ice Cream Tub',
      brand: 'Wall’s Commercial',
      catName: 'Desserts & Sweet Mix',
      unitSymbol: 'L',
      price: 850,
      lowStock: 5,
      supplierName: 'Noor Dairy & Cheese',
      mainStock: 30,
      branchStock: 12,
      kitchenStock: 5,
    },
  ];

  const ingredientMap = new Map<string, any>();
  for (const raw of rawIngredients) {
    let ing = await prisma.ingredient.findFirst({ where: { name: raw.name } });
    const catId = ingCatMap.get(raw.catName);
    const uId = unitMap.get(raw.unitSymbol);
    const supId = supplierMap.get(raw.supplierName)?.id || null;

    if (!ing) {
      ing = await prisma.ingredient.create({
        data: {
          name: raw.name,
          brand: raw.brand,
          categoryId: catId,
          unitId: uId,
          purchasePrice: raw.price,
          lowStockLevel: raw.lowStock,
          currentStock: raw.branchStock + raw.kitchenStock,
          supplierId: supId,
          outletId: outlet.id,
          status: 'active',
        },
      });
    } else {
      ing = await prisma.ingredient.update({
        where: { id: ing.id },
        data: {
          categoryId: catId,
          unitId: uId,
          purchasePrice: raw.price,
          lowStockLevel: raw.lowStock,
          currentStock: raw.branchStock + raw.kitchenStock,
          supplierId: supId,
          outletId: outlet.id,
        },
      });
    }
    ingredientMap.set(raw.name, ing);

    // Seed Stocks into Main, Branch, and Kitchen Warehouses!
    await prisma.warehouseStock.upsert({
      where: {
        warehouseId_ingredientId: { warehouseId: mainWarehouse.id, ingredientId: ing.id },
      },
      update: { currentStock: raw.mainStock, lowStockLevel: raw.lowStock * 2 },
      create: {
        warehouseId: mainWarehouse.id,
        ingredientId: ing.id,
        currentStock: raw.mainStock,
        lowStockLevel: raw.lowStock * 2,
      },
    });

    await prisma.warehouseStock.upsert({
      where: {
        warehouseId_ingredientId: { warehouseId: branchWarehouse.id, ingredientId: ing.id },
      },
      update: { currentStock: raw.branchStock, lowStockLevel: raw.lowStock },
      create: {
        warehouseId: branchWarehouse.id,
        ingredientId: ing.id,
        currentStock: raw.branchStock,
        lowStockLevel: raw.lowStock,
      },
    });

    await prisma.warehouseStock.upsert({
      where: {
        warehouseId_ingredientId: { warehouseId: kitchenWarehouse.id, ingredientId: ing.id },
      },
      update: { currentStock: raw.kitchenStock, lowStockLevel: Math.floor(raw.lowStock / 2) },
      create: {
        warehouseId: kitchenWarehouse.id,
        ingredientId: ing.id,
        currentStock: raw.kitchenStock,
        lowStockLevel: Math.floor(raw.lowStock / 2),
      },
    });
  }
  console.log('✅ Created ingredients and distributed live stock across all 3 warehouses');

  // ============================================
  // 10. PRODUCTION ITEMS & STOCK
  // ============================================
  const prodItemsData = [
    { name: 'Marinated Tikka Chicken', unit: 'kg', shelfLifeHours: 48 },
    { name: 'Marinated Fajita Chicken', unit: 'kg', shelfLifeHours: 48 },
    { name: 'Pizza Dough Ball 12-inch', unit: 'pcs', shelfLifeHours: 24 },
    { name: 'Special Garlic Herb Butter', unit: 'kg', shelfLifeHours: 72 },
  ];

  for (const pi of prodItemsData) {
    let prodItem = await prisma.productionItem.findFirst({ where: { name: pi.name } });
    if (!prodItem) {
      prodItem = await prisma.productionItem.create({
        data: {
          name: pi.name,
          unit: pi.unit,
          shelfLifeHours: pi.shelfLifeHours,
          isActive: true,
        },
      });
    }

    await prisma.productionWarehouseStock.upsert({
      where: {
        productionItemId_warehouseId: { productionItemId: prodItem.id, warehouseId: kitchenWarehouse.id },
      },
      update: { currentStock: 25 },
      create: {
        productionItemId: prodItem.id,
        warehouseId: kitchenWarehouse.id,
        currentStock: 25,
      },
    });
  }
  console.log('✅ Created production items and kitchen production stock');

  // ============================================
  // 11. KITCHEN CONFIGURATION
  // ============================================
  // await prisma.kitchen.deleteMany();
  await prisma.kitchen.create({
    data: {
      name: 'Main Kitchen',
      assignedCategories: ['Pizza', 'Burgers', 'Pasta', 'Appetizers', 'Beverages', 'Desserts'],
      status: 'active',
    },
  });
  console.log('✅ Created Main Kitchen');

  // ============================================
  // 12. MEAL TYPES
  // ============================================
  const mealTypes = ['Breakfast', 'Lunch', 'Dinner', 'High Tea', 'Midnight Craving'];
  for (const mt of mealTypes) {
    await prisma.mealType.upsert({
      where: { name: mt },
      update: {},
      create: { name: mt, status: 'active' },
    });
  }
  console.log('✅ Created meal types');

  // ============================================
  // 13. FOOD CATEGORIES
  // ============================================
  const foodCats = [
    { name: 'Pizza', displayOrder: 1 },
    { name: 'Burgers', displayOrder: 2 },
    { name: 'Pasta', displayOrder: 3 },
    { name: 'Appetizers', displayOrder: 4 },
    { name: 'Beverages', displayOrder: 5 },
    { name: 'Desserts', displayOrder: 6 },
  ];

  const foodCatMap = new Map<string, string>();
  for (const fc of foodCats) {
    let cat = await prisma.foodCategory.findFirst({ where: { name: fc.name } });
    if (!cat) {
      cat = await prisma.foodCategory.create({
        data: { name: fc.name, displayOrder: fc.displayOrder, status: 'active' },
      });
    }
    foodCatMap.set(fc.name, cat.id);
  }
  console.log('✅ Created food menu categories');

  // ============================================
  // 14. MODIFIERS
  // ============================================
  const cheeseIng = ingredientMap.get('Mozzarella Cheese Block');
  const jalapenoIng = ingredientMap.get('Jalapeno Pepper Slices');
  const oliveIng = ingredientMap.get('Black Sliced Olives');
  const garlicSauceIng = ingredientMap.get('Garlic Mayo Sauce');

  const modifiersData = [
    { name: 'Extra Cheese', price: 150, type: 'addon', ingredientId: cheeseIng?.id },
    { name: 'Extra Jalapenos', price: 60, type: 'addon', ingredientId: jalapenoIng?.id },
    { name: 'Extra Olives', price: 60, type: 'addon', ingredientId: oliveIng?.id },
    { name: 'Garlic Mayo Dip', price: 70, type: 'addon', ingredientId: garlicSauceIng?.id },
    { name: 'No Onions', price: 0, type: 'removal', ingredientId: null },
  ];

  const modifierMap = new Map<string, any>();
  for (const m of modifiersData) {
    let mod = await prisma.modifier.findFirst({ where: { name: m.name } });
    if (!mod) {
      mod = await prisma.modifier.create({
        data: {
          name: m.name,
          price: m.price,
          type: m.type,
          status: 'active',
          ingredientId: m.ingredientId,
        },
      });
    }
    modifierMap.set(m.name, mod);
  }
  console.log('✅ Created modifiers & addon items');

  // ============================================
  // 15. MENU ITEMS, VARIANTS & RECIPES
  // ============================================
  const chickenFillet = ingredientMap.get('Chicken Breast Fillet');
  const doughFlour = ingredientMap.get('Pizza Dough Flour');
  const pizzaSauce = ingredientMap.get('Ovenisto Pizza Red Sauce');
  const burgerBun = ingredientMap.get('Gourmet Burger Buns');
  const beefPatty = ingredientMap.get('Beef Burger Patty');
  const friesCut = ingredientMap.get('French Fries Cut Potatoes');
  const fettuccine = ingredientMap.get('Fettuccine Pasta');
  const heavyCream = ingredientMap.get('Heavy Cooking Cream');
  const garlicBaguette = ingredientMap.get('Garlic Bread Baguette');
  const cokePet = ingredientMap.get('Coca Cola 500ml Pet');
  const spritePet = ingredientMap.get('Sprite 500ml Pet');
  const waterPet = ingredientMap.get('Mineral Water 500ml');
  const lavaMix = ingredientMap.get('Choco Lava Cake Portion');
  const iceCream = ingredientMap.get('Vanilla Ice Cream Tub');

  const menuItems = [
    {
      name: 'Chicken Tikka Pizza',
      code: 'PIZ-TIKKA',
      catName: 'Pizza',
      basePrice: 1299,
      dineInPrice: 1299,
      takeAwayPrice: 1299,
      deliveryPrice: 1350,
      foodpandaPrice: 1399,
      cookingTime: 18,
      tags: ['Bestseller', 'Spicy', 'Chef Special'],
      variants: [
        { name: 'Small (8")', price: 699, displayOrder: 1 },
        { name: 'Medium (10")', price: 1299, displayOrder: 2 },
        { name: 'Large (13")', price: 1899, displayOrder: 3 },
      ],
      recipes: [
        { ingredientId: chickenFillet?.id, qty: 0.15, unitId: kgId },
        { ingredientId: cheeseIng?.id, qty: 0.18, unitId: kgId },
        { ingredientId: pizzaSauce?.id, qty: 0.08, unitId: kgId },
        { ingredientId: doughFlour?.id, qty: 0.22, unitId: kgId },
      ],
    },
    {
      name: 'Chicken Fajita Sensation Pizza',
      code: 'PIZ-FAJITA',
      catName: 'Pizza',
      basePrice: 1299,
      dineInPrice: 1299,
      takeAwayPrice: 1299,
      deliveryPrice: 1350,
      foodpandaPrice: 1399,
      cookingTime: 18,
      tags: ['Mild', 'Popular'],
      variants: [
        { name: 'Small (8")', price: 699, displayOrder: 1 },
        { name: 'Medium (10")', price: 1299, displayOrder: 2 },
        { name: 'Large (13")', price: 1899, displayOrder: 3 },
      ],
      recipes: [
        { ingredientId: chickenFillet?.id, qty: 0.15, unitId: kgId },
        { ingredientId: cheeseIng?.id, qty: 0.18, unitId: kgId },
        { ingredientId: pizzaSauce?.id, qty: 0.08, unitId: kgId },
        { ingredientId: doughFlour?.id, qty: 0.22, unitId: kgId },
      ],
    },
    {
      name: 'Pepperoni Feast Pizza',
      code: 'PIZ-PEP',
      catName: 'Pizza',
      basePrice: 1399,
      dineInPrice: 1399,
      takeAwayPrice: 1399,
      deliveryPrice: 1450,
      foodpandaPrice: 1499,
      cookingTime: 18,
      tags: ['Meat Lover'],
      variants: [
        { name: 'Small (8")', price: 749, displayOrder: 1 },
        { name: 'Medium (10")', price: 1399, displayOrder: 2 },
        { name: 'Large (13")', price: 1999, displayOrder: 3 },
      ],
      recipes: [
        { ingredientId: cheeseIng?.id, qty: 0.20, unitId: kgId },
        { ingredientId: pizzaSauce?.id, qty: 0.08, unitId: kgId },
        { ingredientId: doughFlour?.id, qty: 0.22, unitId: kgId },
      ],
    },
    {
      name: 'Crispy Zinger Burger',
      code: 'BRG-ZING',
      catName: 'Burgers',
      basePrice: 499,
      dineInPrice: 499,
      takeAwayPrice: 499,
      deliveryPrice: 520,
      foodpandaPrice: 549,
      cookingTime: 12,
      tags: ['Bestseller', 'Crispy'],
      variants: [],
      recipes: [
        { ingredientId: chickenFillet?.id, qty: 0.14, unitId: kgId },
        { ingredientId: burgerBun?.id, qty: 1, unitId: pcsId },
        { ingredientId: garlicSauceIng?.id, qty: 0.03, unitId: kgId },
      ],
    },
    {
      name: 'Ovenisto Gourmet Beef Burger',
      code: 'BRG-BEEF',
      catName: 'Burgers',
      basePrice: 699,
      dineInPrice: 699,
      takeAwayPrice: 699,
      deliveryPrice: 720,
      foodpandaPrice: 749,
      cookingTime: 15,
      tags: ['Juicy', 'Chef Special'],
      variants: [],
      recipes: [
        { ingredientId: beefPatty?.id, qty: 1, unitId: pcsId },
        { ingredientId: burgerBun?.id, qty: 1, unitId: pcsId },
        { ingredientId: cheeseIng?.id, qty: 0.04, unitId: kgId },
      ],
    },
    {
      name: 'Fettuccine Alfredo Pasta',
      code: 'PAS-ALF',
      catName: 'Pasta',
      basePrice: 899,
      dineInPrice: 899,
      takeAwayPrice: 899,
      deliveryPrice: 920,
      foodpandaPrice: 950,
      cookingTime: 15,
      tags: ['Creamy', 'Cheesy'],
      variants: [],
      recipes: [
        { ingredientId: fettuccine?.id, qty: 0.15, unitId: kgId },
        { ingredientId: chickenFillet?.id, qty: 0.10, unitId: kgId },
        { ingredientId: heavyCream?.id, qty: 0.12, unitId: lId },
        { ingredientId: cheeseIng?.id, qty: 0.06, unitId: kgId },
      ],
    },
    {
      name: 'Garlic Bread with Cheese (4 Pcs)',
      code: 'APP-GB',
      catName: 'Appetizers',
      basePrice: 349,
      dineInPrice: 349,
      takeAwayPrice: 349,
      deliveryPrice: 349,
      foodpandaPrice: 380,
      cookingTime: 8,
      tags: ['Starter'],
      variants: [],
      recipes: [
        { ingredientId: garlicBaguette?.id, qty: 0.5, unitId: pcsId },
        { ingredientId: cheeseIng?.id, qty: 0.08, unitId: kgId },
      ],
    },
    {
      name: 'Crispy Buffalo Wings (6 Pcs)',
      code: 'APP-WNG6',
      catName: 'Appetizers',
      basePrice: 449,
      dineInPrice: 449,
      takeAwayPrice: 449,
      deliveryPrice: 460,
      foodpandaPrice: 490,
      cookingTime: 12,
      tags: ['Spicy'],
      variants: [],
      recipes: [{ ingredientId: chickenFillet?.id, qty: 0.25, unitId: kgId }],
    },
    {
      name: 'Gourmet French Fries (Regular)',
      code: 'APP-FRIES',
      catName: 'Appetizers',
      basePrice: 220,
      dineInPrice: 220,
      takeAwayPrice: 220,
      deliveryPrice: 220,
      foodpandaPrice: 250,
      cookingTime: 6,
      tags: ['Crispy'],
      variants: [],
      recipes: [{ ingredientId: friesCut?.id, qty: 0.22, unitId: kgId }],
    },
    {
      name: 'Coca Cola 500ml',
      code: 'BEV-COKE',
      catName: 'Beverages',
      basePrice: 100,
      dineInPrice: 100,
      takeAwayPrice: 100,
      deliveryPrice: 100,
      foodpandaPrice: 120,
      cookingTime: 1,
      tags: ['Chilled'],
      variants: [],
      recipes: [{ ingredientId: cokePet?.id, qty: 1, unitId: pcsId }],
    },
    {
      name: 'Sprite 500ml',
      code: 'BEV-SPRITE',
      catName: 'Beverages',
      basePrice: 100,
      dineInPrice: 100,
      takeAwayPrice: 100,
      deliveryPrice: 100,
      foodpandaPrice: 120,
      cookingTime: 1,
      tags: ['Chilled'],
      variants: [],
      recipes: [{ ingredientId: spritePet?.id, qty: 1, unitId: pcsId }],
    },
    {
      name: 'Mineral Water 500ml',
      code: 'BEV-WATER',
      catName: 'Beverages',
      basePrice: 60,
      dineInPrice: 60,
      takeAwayPrice: 60,
      deliveryPrice: 60,
      foodpandaPrice: 70,
      cookingTime: 1,
      tags: ['Chilled'],
      variants: [],
      recipes: [{ ingredientId: waterPet?.id, qty: 1, unitId: pcsId }],
    },
    {
      name: 'Choco Molten Lava Cake with Ice Cream',
      code: 'DES-LAVA',
      catName: 'Desserts',
      basePrice: 450,
      dineInPrice: 450,
      takeAwayPrice: 450,
      deliveryPrice: 450,
      foodpandaPrice: 490,
      cookingTime: 10,
      tags: ['Sweet', 'Hot & Cold'],
      variants: [],
      recipes: [
        { ingredientId: lavaMix?.id, qty: 1, unitId: pcsId },
        { ingredientId: iceCream?.id, qty: 0.08, unitId: lId },
      ],
    },
  ];

  const menuItemMap = new Map<string, any>();
  const variantMap = new Map<string, any>();

  for (const item of menuItems) {
    const catId = foodCatMap.get(item.catName);
    let menuItem = await prisma.foodMenuItem.findFirst({ where: { code: item.code } });

    if (!menuItem) {
      menuItem = await prisma.foodMenuItem.create({
        data: {
          name: item.name,
          code: item.code,
          categoryId: catId,
          price: item.basePrice,
          dineInPrice: item.dineInPrice,
          takeAwayPrice: item.takeAwayPrice,
          deliveryPrice: item.deliveryPrice,
          foodpandaPrice: item.foodpandaPrice,
          cookingTime: item.cookingTime,
          tags: item.tags,
          available: true,
          lowStockAlert: 5,
        },
      });
    } else {
      menuItem = await prisma.foodMenuItem.update({
        where: { id: menuItem.id },
        data: {
          name: item.name,
          categoryId: catId,
          price: item.basePrice,
          dineInPrice: item.dineInPrice,
          takeAwayPrice: item.takeAwayPrice,
          deliveryPrice: item.deliveryPrice,
          foodpandaPrice: item.foodpandaPrice,
          cookingTime: item.cookingTime,
          tags: item.tags,
          available: true,
        },
      });
    }
    menuItemMap.set(item.code, menuItem);

    if (item.variants && item.variants.length > 0) {
      for (const v of item.variants) {
        let variant = await prisma.foodMenuVariant.findFirst({
          where: { menuItemId: menuItem.id, name: v.name },
        });
        if (!variant) {
          variant = await prisma.foodMenuVariant.create({
            data: {
              menuItemId: menuItem.id,
              name: v.name,
              price: v.price,
              dineInPrice: v.price,
              takeAwayPrice: v.price,
              deliveryPrice: v.price + 50,
              displayOrder: v.displayOrder,
            },
          });
        }
        variantMap.set(`${item.code}-${v.name}`, variant);
      }
    }

    if (item.recipes && item.recipes.length > 0) {
      await prisma.foodRecipe.deleteMany({ where: { menuItemId: menuItem.id } });
      for (const r of item.recipes) {
        if (r.ingredientId) {
          await prisma.foodRecipe.create({
            data: {
              menuItemId: menuItem.id,
              ingredientId: r.ingredientId,
              qtyPerUnit: r.qty,
              usageUnitId: r.unitId,
            },
          });
        }
      }
    }

    if (['Pizza', 'Burgers'].includes(item.catName)) {
      const extraCheeseMod = modifierMap.get('Extra Cheese');
      const dipMod = modifierMap.get('Garlic Mayo Dip');
      if (extraCheeseMod) {
        await prisma.menuItemModifier.upsert({
          where: {
            menuItemId_modifierId: { menuItemId: menuItem.id, modifierId: extraCheeseMod.id },
          },
          update: {},
          create: {
            menuItemId: menuItem.id,
            modifierId: extraCheeseMod.id,
            sellingPrice: extraCheeseMod.price,
          },
        });
      }
      if (dipMod) {
        await prisma.menuItemModifier.upsert({
          where: {
            menuItemId_modifierId: { menuItemId: menuItem.id, modifierId: dipMod.id },
          },
          update: {},
          create: {
            menuItemId: menuItem.id,
            modifierId: dipMod.id,
            sellingPrice: dipMod.price,
          },
        });
      }
    }
  }
  console.log('✅ Created menu items with variants, recipes, and modifiers');

  // ============================================
  // 16. DEALS & COMBOS (All Deal Types Seeded)
  // ============================================
  const zingerItem = menuItemMap.get('BRG-ZING');
  const beefBurgerItem = menuItemMap.get('BRG-BEEF');
  const friesItem = menuItemMap.get('APP-FRIES');
  const wingsItem = menuItemMap.get('APP-WNG6');
  const cokeItem = menuItemMap.get('BEV-COKE');
  const spriteItem = menuItemMap.get('BEV-SPRITE');
  const tikkaItem = menuItemMap.get('PIZ-TIKKA');
  const fajitaItem = menuItemMap.get('PIZ-FAJITA');
  const pepperoniItem = menuItemMap.get('PIZ-PEP');
  const garlicBreadItem = menuItemMap.get('APP-GB');
  const lavaCakeItem = menuItemMap.get('DES-LAVA');
  const tikkaLargeVariant = variantMap.get('PIZ-TIKKA-Large (13")');
  const tikkaMediumVariant = variantMap.get('PIZ-TIKKA-Medium (10")');
  const fajitaMediumVariant = variantMap.get('PIZ-FAJITA-Medium (10")');
  const pepMediumVariant = variantMap.get('PIZ-PEP-Medium (10")');

  // Deal 1: Midnight Zinger Combo (COMBO)
  const deal1 = await prisma.deal.upsert({
    where: { code: 'DEAL-ZINGER' },
    update: {
      name: 'Midnight Zinger Combo',
      description: '2 Zinger Burgers + 1 Regular Fries + 2 Coca Cola 500ml',
      type: DealType.COMBO,
      price: 1199,
      dineInPrice: 1199,
      takeAwayPrice: 1199,
      deliveryPrice: 1250,
      foodpandaPrice: 1299,
      isActive: true,
      validFrom: new Date('2024-01-01'),
    },
    create: {
      name: 'Midnight Zinger Combo',
      code: 'DEAL-ZINGER',
      description: '2 Zinger Burgers + 1 Regular Fries + 2 Coca Cola 500ml',
      type: DealType.COMBO,
      price: 1199,
      dineInPrice: 1199,
      takeAwayPrice: 1199,
      deliveryPrice: 1250,
      foodpandaPrice: 1299,
      isActive: true,
      validFrom: new Date('2024-01-01'),
      outletIds: [outlet.id],
    },
  });

  if (zingerItem && friesItem && cokeItem) {
    await prisma.dealComponent.deleteMany({ where: { dealId: deal1.id } });
    await prisma.dealComponent.createMany({
      data: [
        { dealId: deal1.id, menuItemId: zingerItem.id, qty: 2, displayOrder: 1 },
        { dealId: deal1.id, menuItemId: friesItem.id, qty: 1, displayOrder: 2 },
        { dealId: deal1.id, menuItemId: cokeItem.id, qty: 2, displayOrder: 3 },
      ],
    });
  }

  // Deal 2: Ovenisto Family Feast (COMBO)
  const deal2 = await prisma.deal.upsert({
    where: { code: 'DEAL-FAMILY' },
    update: {
      name: 'Ovenisto Family Feast',
      description: '1 Large Tikka Pizza + 1 Garlic Bread + 1 Fries + 2 Drinks',
      type: DealType.COMBO,
      price: 2499,
      dineInPrice: 2499,
      takeAwayPrice: 2499,
      deliveryPrice: 2550,
      foodpandaPrice: 2699,
      isActive: true,
      validFrom: new Date('2024-01-01'),
    },
    create: {
      name: 'Ovenisto Family Feast',
      code: 'DEAL-FAMILY',
      description: '1 Large Tikka Pizza + 1 Garlic Bread + 1 Fries + 2 Drinks',
      type: DealType.COMBO,
      price: 2499,
      dineInPrice: 2499,
      takeAwayPrice: 2499,
      deliveryPrice: 2550,
      foodpandaPrice: 2699,
      isActive: true,
      validFrom: new Date('2024-01-01'),
      outletIds: [outlet.id],
    },
  });

  if (tikkaItem && garlicBreadItem && friesItem && cokeItem) {
    await prisma.dealComponent.deleteMany({ where: { dealId: deal2.id } });
    await prisma.dealComponent.createMany({
      data: [
        {
          dealId: deal2.id,
          menuItemId: tikkaItem.id,
          variantId: tikkaLargeVariant?.id || null,
          qty: 1,
          displayOrder: 1,
        },
        { dealId: deal2.id, menuItemId: garlicBreadItem.id, qty: 1, displayOrder: 2 },
        { dealId: deal2.id, menuItemId: friesItem.id, qty: 1, displayOrder: 3 },
        { dealId: deal2.id, menuItemId: cokeItem.id, qty: 2, displayOrder: 4 },
      ],
    });
  }

  // Deal 3: Duo Medium Pizza Combo (COMBO)
  const deal3 = await prisma.deal.upsert({
    where: { code: 'DEAL-DUO-PIZZA' },
    update: {
      name: 'Duo Medium Pizza Offer',
      description: '1 Medium Tikka Pizza + 1 Medium Fajita Pizza + 2 Drinks',
      type: DealType.COMBO,
      price: 2199,
      dineInPrice: 2199,
      takeAwayPrice: 2199,
      deliveryPrice: 2250,
      foodpandaPrice: 2399,
      isActive: true,
      validFrom: new Date('2024-01-01'),
    },
    create: {
      name: 'Duo Medium Pizza Offer',
      code: 'DEAL-DUO-PIZZA',
      description: '1 Medium Tikka Pizza + 1 Medium Fajita Pizza + 2 Drinks',
      type: DealType.COMBO,
      price: 2199,
      dineInPrice: 2199,
      takeAwayPrice: 2199,
      deliveryPrice: 2250,
      foodpandaPrice: 2399,
      isActive: true,
      validFrom: new Date('2024-01-01'),
      outletIds: [outlet.id],
    },
  });

  if (tikkaItem && fajitaItem && cokeItem) {
    await prisma.dealComponent.deleteMany({ where: { dealId: deal3.id } });
    await prisma.dealComponent.createMany({
      data: [
        {
          dealId: deal3.id,
          menuItemId: tikkaItem.id,
          variantId: tikkaMediumVariant?.id || null,
          qty: 1,
          displayOrder: 1,
        },
        {
          dealId: deal3.id,
          menuItemId: fajitaItem.id,
          variantId: fajitaMediumVariant?.id || null,
          qty: 1,
          displayOrder: 2,
        },
        { dealId: deal3.id, menuItemId: cokeItem.id, qty: 2, displayOrder: 3 },
      ],
    });
  }

  // Deal 4: Buy 1 Large Pizza Get 1 Free Appetizer (BUY_X_GET_Y / BOGO)
  if (tikkaItem && wingsItem) {
    const bogoDeal = await prisma.deal.upsert({
      where: { code: 'DEAL-BOGO-WINGS' },
      update: {
        name: 'Buy Large Pizza Get 6 Wings Free',
        description: 'Order any Large Tikka Pizza and get 6 Pcs Buffalo Wings FREE!',
        type: DealType.BUY_X_GET_Y,
        buyItemId: tikkaItem.id,
        buyVariantId: tikkaLargeVariant?.id || null,
        buyQty: 1,
        getItemId: wingsItem.id,
        getQty: 1,
        isActive: true,
        validFrom: new Date('2024-01-01'),
      },
      create: {
        name: 'Buy Large Pizza Get 6 Wings Free',
        code: 'DEAL-BOGO-WINGS',
        description: 'Order any Large Tikka Pizza and get 6 Pcs Buffalo Wings FREE!',
        type: DealType.BUY_X_GET_Y,
        buyItemId: tikkaItem.id,
        buyVariantId: tikkaLargeVariant?.id || null,
        buyQty: 1,
        getItemId: wingsItem.id,
        getQty: 1,
        isActive: true,
        validFrom: new Date('2024-01-01'),
        outletIds: [outlet.id],
      },
    });

    await prisma.dealBogoItem.deleteMany({ where: { dealId: bogoDeal.id } });
    await prisma.dealBogoItem.createMany({
      data: [
        {
          dealId: bogoDeal.id,
          role: BogoRole.BUY,
          menuItemId: tikkaItem.id,
          variantId: tikkaLargeVariant?.id || null,
          qty: 1,
          displayOrder: 1,
        },
        {
          dealId: bogoDeal.id,
          role: BogoRole.GET,
          menuItemId: wingsItem.id,
          variantId: null,
          qty: 1,
          displayOrder: 1,
        },
      ],
    });
  }

  // Deal 5: Promo Code OVEN15 (PROMO_CODE — has a code)
  await prisma.deal.upsert({
    where: { code: 'OVEN15' },
    update: {
      name: '15% Off Discount Code',
      description: 'Get 15% discount on orders above Rs. 1500 using coupon OVEN15',
      type: DealType.PROMO_CODE,
      discountPercent: 15,
      minSpend: 1500,
      isActive: true,
      validFrom: new Date('2024-01-01'),
    },
    create: {
      name: '15% Off Discount Code',
      code: 'OVEN15',
      description: 'Get 15% discount on orders above Rs. 1500 using coupon OVEN15',
      type: DealType.PROMO_CODE,
      discountPercent: 15,
      minSpend: 1500,
      isActive: true,
      validFrom: new Date('2024-01-01'),
      outletIds: [outlet.id],
    },
  });

  // Deal 6: Flat Rs. 300 Off using coupon FLAT300 (PROMO_CODE — has a code, so the
  // pre-split resolveOrderDiscount only ever matched it via an explicitly-entered
  // code; the backfill script classifies it the same way, on that same rule).
  await prisma.deal.upsert({
    where: { code: 'FLAT300' },
    update: {
      name: 'Flat Rs. 300 Off Deal',
      description: 'Get Rs. 300 flat off on all orders above Rs. 2000 using coupon FLAT300',
      type: DealType.PROMO_CODE,
      flatDiscount: 300,
      minSpend: 2000,
      isActive: true,
      validFrom: new Date('2024-01-01'),
    },
    create: {
      name: 'Flat Rs. 300 Off Deal',
      code: 'FLAT300',
      description: 'Get Rs. 300 flat off on all orders above Rs. 2000 using coupon FLAT300',
      type: DealType.PROMO_CODE,
      flatDiscount: 300,
      minSpend: 2000,
      isActive: true,
      validFrom: new Date('2024-01-01'),
      outletIds: [outlet.id],
    },
  });

  // Deal 7: Auto-applied Rs. 200 off orders above Rs. 2500 (MIN_SPEND — no code, applies
  // automatically to the best-qualifying order; new deal type, seeded for real coverage).
  const autoDiscountData = {
    description: 'Automatically applied: Rs. 200 off orders above Rs. 2500',
    type: DealType.MIN_SPEND,
    flatDiscount: 200,
    minSpend: 2500,
    isActive: true,
    validFrom: new Date('2024-01-01'),
  };
  const existingAutoDiscount = await prisma.deal.findFirst({ where: { name: 'Big Order Auto Discount' } });
  if (existingAutoDiscount) {
    await prisma.deal.update({ where: { id: existingAutoDiscount.id }, data: autoDiscountData });
  } else {
    await prisma.deal.create({
      data: { name: 'Big Order Auto Discount', ...autoDiscountData, outletIds: [outlet.id] },
    });
  }
  console.log('✅ Created 7 distinct Deals & Combo bundles');

  // ============================================
  // 17. RESTAURANT TABLES (Multi-Floor Table Layout)
  // ============================================
  await prisma.restaurantTable.deleteMany({ where: { outletId: outlet.id } });

  const tablesData = [
    // Ground Floor (Main Hall) - Tables 1 to 8
    { number: '1', capacity: 2, floor: 'Ground Floor', shape: 'square' },
    { number: '2', capacity: 2, floor: 'Ground Floor', shape: 'square' },
    { number: '3', capacity: 4, floor: 'Ground Floor', shape: 'square' },
    { number: '4', capacity: 4, floor: 'Ground Floor', shape: 'square' },
    { number: '5', capacity: 6, floor: 'Ground Floor', shape: 'rectangle' },
    { number: '6', capacity: 6, floor: 'Ground Floor', shape: 'rectangle' },
    { number: '7', capacity: 8, floor: 'Ground Floor', shape: 'rectangle' },
    { number: '8', capacity: 4, floor: 'Ground Floor', shape: 'round' },

    // First Floor (Family Hall) - Tables 9 to 14
    { number: '9', capacity: 4, floor: 'First Floor', shape: 'square' },
    { number: '10', capacity: 4, floor: 'First Floor', shape: 'square' },
    { number: '11', capacity: 6, floor: 'First Floor', shape: 'rectangle' },
    { number: '12', capacity: 6, floor: 'First Floor', shape: 'rectangle' },
    { number: '13', capacity: 8, floor: 'First Floor', shape: 'rectangle' },
    { number: '14', capacity: 4, floor: 'First Floor', shape: 'round' },

    // Outdoor Terrace (Open Air) - Tables 15 to 18
    { number: '15', capacity: 4, floor: 'Outdoor Terrace', shape: 'round' },
    { number: '16', capacity: 4, floor: 'Outdoor Terrace', shape: 'round' },
    { number: '17', capacity: 6, floor: 'Outdoor Terrace', shape: 'rectangle' },
    { number: '18', capacity: 6, floor: 'Outdoor Terrace', shape: 'rectangle' },

    // VIP Lounge - Tables 19 & 20
    { number: '19', capacity: 10, floor: 'VIP Lounge', shape: 'rectangle' },
    { number: '20', capacity: 12, floor: 'VIP Lounge', shape: 'rectangle' },
  ];

  for (const t of tablesData) {
    await prisma.restaurantTable.create({
      data: {
        outletId: outlet.id,
        number: t.number,
        capacity: t.capacity,
        floor: t.floor,
        shape: t.shape,
        status: 'available',
      },
    });
  }
  console.log('✅ Created multi-floor restaurant tables (Tables 1-20) for Waiter Panel & Table Layout');

  // ============================================
  // 18. CUSTOMERS & LOYALTY
  // ============================================
  const customersData = [
    {
      name: 'Muhammad Bilal',
      phone: '03001234567',
      email: 'bilal.customer@gmail.com',
      address: 'House 12, Street 4, Clifton Block 2, Karachi',
      customerType: 'regular',
      loyaltyPoints: 450,
      totalOrders: 6,
      totalSpent: 8400,
    },
    {
      name: 'Ayesha Khan',
      phone: '03219876543',
      email: 'ayesha.k@gmail.com',
      address: 'Apartment 5B, Phase 5 DHA, Karachi',
      customerType: 'vip',
      loyaltyPoints: 1200,
      totalOrders: 14,
      totalSpent: 22500,
    },
    {
      name: 'Tariq Mehmood',
      phone: '03335551234',
      email: 'tariq.corp@bizcorp.pk',
      address: 'Office 301, Business Tower, Shahrah-e-Faisal, Karachi',
      customerType: 'corporate',
      loyaltyPoints: 800,
      totalOrders: 8,
      totalSpent: 16000,
    },
    {
      name: 'Zainab Ali',
      phone: '03457778899',
      email: 'zainab.ali@outlook.com',
      address: 'Flat 102, Gulshan-e-Iqbal Block 13D, Karachi',
      customerType: 'regular',
      loyaltyPoints: 250,
      totalOrders: 3,
      totalSpent: 3900,
    },
    {
      name: 'Omer Farooq',
      phone: '03123344556',
      email: 'omer.f@gmail.com',
      address: 'North Nazimabad Block H, Karachi',
      customerType: 'walk-in',
      loyaltyPoints: 50,
      totalOrders: 1,
      totalSpent: 1200,
    },
  ];

  for (const c of customersData) {
    let customer = await prisma.customer.findFirst({ where: { phone: c.phone } });
    if (!customer) {
      customer = await prisma.customer.create({
        data: {
          name: c.name,
          phone: c.phone,
          email: c.email,
          address: c.address,
          customerType: c.customerType,
          loyaltyPoints: c.loyaltyPoints,
          totalOrders: c.totalOrders,
          totalSpent: c.totalSpent,
          outletId: outlet.id,
        },
      });
    } else {
      customer = await prisma.customer.update({
        where: { id: customer.id },
        data: {
          name: c.name,
          email: c.email,
          address: c.address,
          customerType: c.customerType,
          loyaltyPoints: c.loyaltyPoints,
          totalOrders: c.totalOrders,
          totalSpent: c.totalSpent,
          outletId: outlet.id,
        },
      });
    }

    await prisma.loyaltyMember.upsert({
      where: { customerId: customer.id },
      update: {
        phone: c.phone,
        totalPoints: c.loyaltyPoints,
        availablePoints: c.loyaltyPoints,
        tier: c.loyaltyPoints >= 1000 ? 'Gold' : c.loyaltyPoints >= 500 ? 'Silver' : 'Bronze',
      },
      create: {
        customerId: customer.id,
        phone: c.phone,
        totalPoints: c.loyaltyPoints,
        availablePoints: c.loyaltyPoints,
        tier: c.loyaltyPoints >= 1000 ? 'Gold' : c.loyaltyPoints >= 500 ? 'Silver' : 'Bronze',
      },
    });
  }
  console.log('✅ Created registered customers with loyalty profiles');

  // ============================================
  // SUMMARY
  // ============================================
  console.log('\n🎉 Database seeded successfully with full test dataset!');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('👑 Super Admin:  superadmin@ovenisto.com  | password123');
  console.log('🏢 Branch Admin: branchadmin@ovenisto.com | password123');
  console.log('👔 Manager:       manager@ovenisto.com     | password123 (PIN: 1234)');
  console.log('💵 Cashier:       cashier@ovenisto.com     | password123');
  console.log('👨‍🍳 Kitchen:       kitchen@ovenisto.com     | password123');
  console.log('🍽️ Waiter:        waiter1@ovenisto.com     | password123');
  console.log('🛵 Rider:         rider1@ovenisto.com      | password123');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
}

main()
  .catch((e) => {
    console.error('❌ Seed error:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
