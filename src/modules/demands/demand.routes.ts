import { Router } from 'express';
import { authenticate } from '../../middleware/authenticate.js';
import { authorize } from '../../middleware/authorize.js';
import { getDemands, getDemand, createDemand, approveDemand, rejectDemand, cancelDemand } from './demand.controller.js';

const approverRoles = ['Super Admin', 'Admin', 'Manager', 'Store Manager'];

export const demandsRouter = Router();

demandsRouter.get('/',              authenticate, getDemands);
demandsRouter.get('/:id',           authenticate, getDemand);
demandsRouter.post('/',             authenticate, createDemand);
demandsRouter.patch('/:id/approve', authenticate, authorize(approverRoles), approveDemand);
demandsRouter.patch('/:id/reject',  authenticate, authorize(approverRoles), rejectDemand);
demandsRouter.patch('/:id/cancel',  authenticate, cancelDemand);
