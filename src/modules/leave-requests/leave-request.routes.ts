import { Router } from 'express';
import { authenticate } from '../../middleware/authenticate.js';
import { authorize } from '../../middleware/authorize.js';
import {
  getMyBalance,
  getAllBalances,
  updateBalance,
  getLeaveRequests,
  submitLeaveRequest,
  cancelLeaveRequest,
  reviewLeaveRequest,
} from './leave-request.controller.js';

const adminRoles = ['Super Admin', 'Admin', 'Manager'];

export const leaveRequestsRouter = Router();

// Specific paths before parameterized — ORDER MATTERS
leaveRequestsRouter.get('/my-balance',       authenticate, getMyBalance);
leaveRequestsRouter.get('/balances',         authenticate, authorize(adminRoles), getAllBalances);
leaveRequestsRouter.put('/balances/:userId', authenticate, authorize(['Super Admin', 'Admin']), updateBalance);

leaveRequestsRouter.get('/',                 authenticate, getLeaveRequests);
leaveRequestsRouter.post('/',                authenticate, submitLeaveRequest);
leaveRequestsRouter.delete('/:id',           authenticate, cancelLeaveRequest);
leaveRequestsRouter.put('/:id/review',       authenticate, authorize(['Super Admin', 'Admin']), reviewLeaveRequest);
