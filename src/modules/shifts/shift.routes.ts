import { Router } from 'express';
import { authenticate } from '../../middleware/authenticate.js';
import { authorize } from '../../middleware/authorize.js';
import { getActiveShift, getShifts, createShift, closeShift } from './shift.controller.js';

const posRoles = ['Super Admin', 'Admin', 'Manager', 'Cashier'];

export const shiftsRouter = Router();

// Public — POS checks for open shift before auth dialog appears
shiftsRouter.get('/active', getActiveShift);

shiftsRouter.get('/',           authenticate, authorize(posRoles), getShifts);
shiftsRouter.post('/',          authenticate, authorize(posRoles), createShift);
shiftsRouter.put('/:id/close',  authenticate, authorize(posRoles), closeShift);
