import { Router } from 'express';
import { authenticate } from '../../middleware/authenticate.js';
import { authorize } from '../../middleware/authorize.js';
import {
  getSalesReport,
  getPnlReport,
  getItemsReport,
  getStockReport,
} from './reports.controller.js';

const reportRoles = ['Super Admin', 'Admin', 'Manager', 'Accountant'];

export const reportsRouter = Router();

reportsRouter.get('/sales', authenticate, authorize(reportRoles), getSalesReport);
reportsRouter.get('/pnl',   authenticate, authorize(reportRoles), getPnlReport);
reportsRouter.get('/items', authenticate, authorize(reportRoles), getItemsReport);
reportsRouter.get('/stock', authenticate, authorize(reportRoles), getStockReport);
