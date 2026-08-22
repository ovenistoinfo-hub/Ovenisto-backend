/**
 * Deal Routes
 */

import { Router } from 'express';
import { authenticate } from '../../middleware/authenticate.js';
import { authorize } from '../../middleware/authorize.js';
import { validateRequest } from '../../middleware/validateRequest.js';
import { dealSchema } from './deal.schema.js';
import { getDeals, getDealById, createDeal, updateDeal, toggleDeal, deleteDeal } from './deal.controller.js';

export const dealRouter = Router();

const writeRoles = ['Super Admin', 'Admin', 'Manager'];

dealRouter.use(authenticate);

dealRouter.get('/', getDeals);
dealRouter.get('/:id', getDealById);
dealRouter.post('/', authorize(writeRoles), validateRequest({ body: dealSchema }), createDeal);
dealRouter.put('/:id', authorize(writeRoles), validateRequest({ body: dealSchema }), updateDeal);
dealRouter.patch('/:id/toggle', authorize(writeRoles), toggleDeal);
dealRouter.delete('/:id', authorize(writeRoles), deleteDeal);
