import { Router } from 'express';
import { authenticate } from '../../middleware/authenticate.js';
import { authorize } from '../../middleware/authorize.js';
import {
  getActiveBalancesController,
  getStaffActiveBalanceController,
  createSettlementController,
  getSettlementHistoryController,
} from './cash-settlement.controller.js';

const managerRoles = ['Super Admin', 'Admin', 'Manager', 'Floor Manager', 'Delivery Manager'];

export const cashSettlementRouter = Router();

cashSettlementRouter.use(authenticate);

cashSettlementRouter.get('/active-balances', authorize(managerRoles), getActiveBalancesController);
cashSettlementRouter.get('/staff/:staffId/active', getStaffActiveBalanceController);
cashSettlementRouter.post('/', authorize(managerRoles), createSettlementController);
cashSettlementRouter.get('/history', getSettlementHistoryController);

