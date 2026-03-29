import { Router } from 'express';
import { authenticate } from '../../middleware/authenticate.js';
import { authorize } from '../../middleware/authorize.js';
import {
  getPurchaseRequests,
  getPurchaseRequest,
  createPurchaseRequest,
  approveRequest,
  rejectRequest,
  cancelRequest,
} from './purchase-request.controller.js';

const approverRoles = ['Super Admin', 'Admin'];
const writeRoles = ['Super Admin', 'Admin', 'Manager', 'Store Manager', 'Kitchen Manager'];

export const purchaseRequestsRouter = Router();

purchaseRequestsRouter.get('/',                authenticate, getPurchaseRequests);
purchaseRequestsRouter.get('/:id',             authenticate, getPurchaseRequest);
purchaseRequestsRouter.post('/',               authenticate, authorize(writeRoles), createPurchaseRequest);
purchaseRequestsRouter.patch('/:id/approve',   authenticate, authorize(approverRoles), approveRequest);
purchaseRequestsRouter.patch('/:id/reject',    authenticate, authorize(approverRoles), rejectRequest);
purchaseRequestsRouter.patch('/:id/cancel',    authenticate, cancelRequest);
