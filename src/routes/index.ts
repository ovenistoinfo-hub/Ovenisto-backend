/**
 * API Routes
 * Root router that aggregates all module routes
 */

import { Router, type Request, type Response } from 'express';
import { ApiResponse } from '../utils/ApiResponse.js';
import authRoutes from '../modules/auth/auth.routes.js';
import userRoutes from '../modules/users/user.routes.js';
import outletRoutes from '../modules/outlets/outlet.routes.js';
import settingsRoutes from '../modules/settings/settings.routes.js';
import menuRoutes from '../modules/menu/menu.routes.js';
import inventoryRoutes from '../modules/inventory/inventory.routes.js';
import stockRoutes from '../modules/stock/stock.routes.js';
import uploadRoutes from '../modules/upload/upload.routes.js';
import { ordersRouter, kitchensRouter } from '../modules/order/order.routes.js';
import { customersRouter } from '../modules/customer/customer.routes.js';
import { shiftsRouter }   from '../modules/shifts/shift.routes.js';
import { deliveryRouter } from '../modules/delivery/delivery.routes.js';
import tableRoutes from '../modules/tables/table.routes.js';
import { mealTypeRouter } from '../modules/mealTypes/mealType.routes.js';
import { warehouseRouter } from '../modules/warehouse/warehouse.routes.js';
import { suppliersRouter } from '../modules/suppliers/supplier.routes.js';
import { purchasesRouter } from '../modules/purchases/purchase.routes.js';
import { expensesRouter }  from '../modules/expenses/expense.routes.js';
import { challansRouter } from '../modules/challans/challan.routes.js';
import { demandsRouter }  from '../modules/demands/demand.routes.js';
import { purchaseRequestsRouter } from '../modules/purchase-requests/purchase-request.routes.js';
import { reportsRouter } from '../modules/reports/reports.routes.js';
import productionItemsRoutes from '../modules/production-items/production-items.routes.js';

const router = Router();

// API info endpoint
router.get('/', (_req: Request, res: Response) => {
  res.json(
    ApiResponse.success({
      name: 'Ovenisto POS API',
      version: '1.0.0',
      documentation: '/api/docs',
      endpoints: {
        health: 'GET /health',
        // Phase 1 (To be implemented)
        auth: {
          login: 'POST /api/auth/login',
          logout: 'POST /api/auth/logout',
          me: 'GET /api/auth/me',
          refresh: 'POST /api/auth/refresh',
        },
        users: 'GET/POST /api/users',
        // Phase 2
        settings: 'GET/PUT /api/settings',
        outlets: 'GET/POST /api/outlets',
        // Phase 3
        menu: {
          categories: '/api/menu/categories',
          items: '/api/menu/items',
          modifiers: '/api/menu/modifiers',
          recipes: '/api/menu/recipes',
        },
        // Phase 4
        inventory: {
          ingredients: '/api/inventory/ingredients',
          categories: '/api/inventory/categories',
          units: '/api/inventory/units',
          preMade: '/api/inventory/pre-made',
          stockTakes: '/api/inventory/stock-takes',
        },
        // Phase 5
        orders: '/api/orders',
        kitchens: '/api/kitchens',
        // Phase 6
        customers: '/api/customers',
        loyalty: '/api/loyalty',
        // Phase 7
        suppliers: '/api/suppliers',
        purchases: '/api/purchases',
        expenses: '/api/expenses',
        // Phase 8
        delivery: '/api/delivery',
        // Phase 9
        attendance: '/api/attendance',
        shifts: '/api/shifts',
        scheduling: '/api/scheduling',
        leave: '/api/leave',
        // Phase 10
        deals: '/api/deals',
        coupons: '/api/coupons',
        reservations: '/api/reservations',
        tables: '/api/tables',
        reports: '/api/reports',
        analytics: '/api/analytics',
        sms: '/api/sms',
      },
    })
  );
});

// ============================================
// MODULE ROUTES (To be added in each phase)
// ============================================

// Phase 1: Authentication & Users
router.use('/auth', authRoutes);
router.use('/users', userRoutes);

// Phase 2: Settings & Outlets
router.use('/settings', settingsRoutes);
router.use('/outlets', outletRoutes);

// Phase W1: Warehouse Management
router.use('/warehouses', warehouseRouter);

// Uploads (Cloudinary)
router.use('/upload', uploadRoutes);

// Phase 3: Menu Management
router.use('/menu', menuRoutes);
router.use('/meal-types', mealTypeRouter);

// Phase 4: Inventory
router.use('/inventory', inventoryRoutes);
router.use('/stock', stockRoutes);
// router.use('/production', productionRoutes);
// router.use('/transfers', transferRoutes);
// router.use('/waste', wasteRoutes);

// Phase 5: Orders & POS
router.use('/orders', ordersRouter);
router.use('/kitchens', kitchensRouter);

// Phase 6: Customers & Loyalty
router.use('/customers', customersRouter);
// router.use('/loyalty', loyaltyRoutes);

// Phase 7: Financial
router.use('/suppliers', suppliersRouter);
router.use('/purchases', purchasesRouter);
router.use('/expenses',  expensesRouter);
router.use('/challans',  challansRouter);
router.use('/demands',   demandsRouter);
router.use('/purchase-requests', purchaseRequestsRouter);

// Phase 8: Delivery
router.use('/delivery', deliveryRouter);

// Phase 9: HR & Staff
// router.use('/attendance', attendanceRoutes);
router.use('/shifts', shiftsRouter);
// router.use('/scheduling', schedulingRoutes);
// router.use('/leave', leaveRoutes);

// Phase 10: Advanced
// router.use('/deals', dealRoutes);
// router.use('/coupons', couponRoutes);
// router.use('/reservations', reservationRoutes);
router.use('/tables', tableRoutes);
router.use('/reports', reportsRouter);
router.use('/production-items', productionItemsRoutes);
// router.use('/analytics', analyticsRoutes);
// router.use('/sms', smsRoutes);
// router.use('/self-order', selfOrderRoutes);

export default router;
