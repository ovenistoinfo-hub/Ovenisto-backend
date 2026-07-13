import { Router } from 'express';
import { authenticate } from '../../middleware/authenticate.js';
import { authorize } from '../../middleware/authorize.js';
import {
  getPurchases,
  getPurchase,
  createPurchase,
  updatePurchase,
  deletePurchase,
  payPurchase,
  getPurchaseStats,
} from './purchase.controller.js';

const writeRoles = ['Super Admin', 'Admin', 'Manager', 'Store Manager'];

export const purchasesRouter = Router();

purchasesRouter.get('/stats/summary', authenticate, getPurchaseStats);
purchasesRouter.get('/',          authenticate, getPurchases);
purchasesRouter.get('/:id',       authenticate, getPurchase);
purchasesRouter.post('/',         authenticate, authorize(writeRoles), createPurchase);
purchasesRouter.post('/:id/pay',  authenticate, authorize(writeRoles), payPurchase);
purchasesRouter.put('/:id',       authenticate, authorize(writeRoles), updatePurchase);
purchasesRouter.delete('/:id',    authenticate, authorize(writeRoles), deletePurchase);
