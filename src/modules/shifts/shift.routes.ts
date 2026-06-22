import { Router } from 'express';
import { authenticate, optionalAuth } from '../../middleware/authenticate.js';
import { authorize } from '../../middleware/authorize.js';
import { getActiveShift, getShifts, createShift, closeShift } from './shift.controller.js';

const posRoles = ['Super Admin', 'Admin', 'Manager', 'Cashier'];

export const shiftsRouter = Router();

// Optional auth: when a token is present (POS staff) the open-shift lookup is scoped to
// their outlet; token-less callers (pre-login probe) still get the first open shift.
shiftsRouter.get('/active', optionalAuth, getActiveShift);

shiftsRouter.get('/',           authenticate, authorize(posRoles), getShifts);
shiftsRouter.post('/',          authenticate, authorize(posRoles), createShift);
shiftsRouter.put('/:id/close',  authenticate, authorize(posRoles), closeShift);
