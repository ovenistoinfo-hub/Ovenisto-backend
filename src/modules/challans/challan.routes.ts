import { Router } from 'express';
import { authenticate } from '../../middleware/authenticate.js';
import { authorize } from '../../middleware/authorize.js';
import {
  getChallans,
  getChallan,
  createChallan,
  dispatchChallan,
  receiveChallan,
  cancelChallan,
  getChallanStats,
} from './challan.controller.js';

const writeRoles = ['Super Admin', 'Admin', 'Manager', 'Store Manager'];
const receiveRoles = ['Admin', 'Manager', 'Kitchen Manager', 'Store Manager'];

export const challansRouter = Router();

challansRouter.get('/stats/summary', authenticate, getChallanStats);
challansRouter.get('/',              authenticate, getChallans);
challansRouter.get('/:id',           authenticate, getChallan);
challansRouter.post('/',             authenticate, authorize(writeRoles), createChallan);
challansRouter.patch('/:id/dispatch', authenticate, authorize(writeRoles), dispatchChallan);
challansRouter.patch('/:id/receive',  authenticate, authorize(receiveRoles), receiveChallan);
challansRouter.patch('/:id/cancel',   authenticate, authorize(writeRoles), cancelChallan);
