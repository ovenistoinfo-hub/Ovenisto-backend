import { Router } from 'express';
import { authenticate } from '../../middleware/authenticate.js';
import { authorize } from '../../middleware/authorize.js';
import {
  getSalesReport,
  getPnlReport,
  getItemsReport,
  getStockReport,
  getDashboard,
  getSalesByChannel,
  getSalesByCategory,
  getSalesByPaymentMethod,
  getTopItems,
  getNetProfit,
} from './reports.controller.js';

const reportRoles = ['Super Admin', 'Admin', 'Manager', 'Accountant'];

export const reportsRouter = Router();

reportsRouter.get('/sales',            authenticate, authorize(reportRoles), getSalesReport);
reportsRouter.get('/pnl',              authenticate, authorize(reportRoles), getPnlReport);
reportsRouter.get('/items',            authenticate, authorize(reportRoles), getItemsReport);
reportsRouter.get('/stock',            authenticate, authorize(reportRoles), getStockReport);
reportsRouter.get('/dashboard',        authenticate, authorize(reportRoles), getDashboard);
reportsRouter.get('/sales-by-channel', authenticate, authorize(reportRoles), getSalesByChannel);
reportsRouter.get('/sales-by-category', authenticate, authorize(reportRoles), getSalesByCategory);
reportsRouter.get('/sales-by-payment-method', authenticate, authorize(reportRoles), getSalesByPaymentMethod);
reportsRouter.get('/top-items', authenticate, authorize(reportRoles), getTopItems);
reportsRouter.get('/net-profit', authenticate, authorize(reportRoles), getNetProfit);
