import { Router } from 'express';
import { authenticate } from '../../middleware/authenticate.js';
import { authorize } from '../../middleware/authorize.js';
import { getMyPenalties, getPenalties } from './penalty.controller.js';

const hrRoles = ['Super Admin', 'Admin'];

export const penaltiesRouter = Router();
penaltiesRouter.use(authenticate);

// Specific paths before parameterized — ORDER MATTERS
penaltiesRouter.get('/mine', getMyPenalties);
penaltiesRouter.get('/', authorize(hrRoles), getPenalties);
