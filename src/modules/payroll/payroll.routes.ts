import { Router } from 'express';
import { authenticate } from '../../middleware/authenticate.js';
import { authorize } from '../../middleware/authorize.js';
import {
  createPaymentLog,
  createBatchPaymentLogs,
  getPaymentLogs,
  calculateDeliveryCommissions,
} from './payroll.controller.js';

const hrRoles = ['Super Admin', 'Admin'];
const commissionRoles = ['Super Admin', 'Admin', 'Manager'];

export const payrollRouter = Router();

payrollRouter.use(authenticate);

// Commission calculation — accessible to Managers too, registered before the
// narrower global authorize so Manager is not blocked.
payrollRouter.get('/calculate-commissions', authorize(commissionRoles), calculateDeliveryCommissions);

payrollRouter.use(authorize(hrRoles));

payrollRouter.post('/pay', createPaymentLog);
payrollRouter.post('/pay-batch', createBatchPaymentLogs);
payrollRouter.get('/logs', getPaymentLogs);
