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

// Phase 3: Menu Management
router.use('/menu', menuRoutes);

// Phase 4: Inventory
router.use('/inventory', inventoryRoutes);
router.use('/stock', stockRoutes);
// router.use('/production', productionRoutes);
// router.use('/transfers', transferRoutes);
// router.use('/waste', wasteRoutes);

// Phase 5: Orders & POS
// router.use('/orders', orderRoutes);
// router.use('/kitchens', kitchenRoutes);

// Phase 6: Customers & Loyalty
// router.use('/customers', customerRoutes);
// router.use('/loyalty', loyaltyRoutes);

// Phase 7: Financial
// router.use('/suppliers', supplierRoutes);
// router.use('/purchases', purchaseRoutes);
// router.use('/expenses', expenseRoutes);

// Phase 8: Delivery
// router.use('/delivery', deliveryRoutes);

// Phase 9: HR & Staff
// router.use('/attendance', attendanceRoutes);
// router.use('/shifts', shiftRoutes);
// router.use('/scheduling', schedulingRoutes);
// router.use('/leave', leaveRoutes);

// Phase 10: Advanced
// router.use('/deals', dealRoutes);
// router.use('/coupons', couponRoutes);
// router.use('/reservations', reservationRoutes);
// router.use('/tables', tableRoutes);
// router.use('/reports', reportRoutes);
// router.use('/analytics', analyticsRoutes);
// router.use('/sms', smsRoutes);
// router.use('/self-order', selfOrderRoutes);

export default router;
