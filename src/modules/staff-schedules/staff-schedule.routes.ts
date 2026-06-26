import { Router } from 'express';
import { authenticate } from '../../middleware/authenticate.js';
import { authorize } from '../../middleware/authorize.js';
import {
  getMySchedule,
  getAllSchedules,
  saveSchedule,
  publishSchedule,
  deleteSchedule,
} from './staff-schedule.controller.js';

const adminRoles = ['Super Admin', 'Admin', 'Manager'];

export const staffSchedulesRouter = Router();

staffSchedulesRouter.get('/my',            authenticate, getMySchedule);

staffSchedulesRouter.get('/',              authenticate, authorize(adminRoles), getAllSchedules);
staffSchedulesRouter.post('/',             authenticate, authorize(adminRoles), saveSchedule);
staffSchedulesRouter.patch('/:id/publish', authenticate, authorize(adminRoles), publishSchedule);
staffSchedulesRouter.delete('/:id',        authenticate, authorize(adminRoles), deleteSchedule);
