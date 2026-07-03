import { Router } from 'express';
import { authenticate } from '../../middleware/authenticate.js';
import { authorize } from '../../middleware/authorize.js';
import {
  createPaymentLog,
  createBatchPaymentLogs,
  getPaymentLogs,
} from './payroll.controller.js';

const hrRoles = ['Super Admin', 'Admin'];

export const payrollRouter = Router();

payrollRouter.use(authenticate);
payrollRouter.use(authorize(hrRoles));

payrollRouter.post('/pay', createPaymentLog);
payrollRouter.post('/pay-batch', createBatchPaymentLogs);
payrollRouter.get('/logs', getPaymentLogs);
