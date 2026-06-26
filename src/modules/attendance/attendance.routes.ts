import { Router } from 'express';
import { authenticate } from '../../middleware/authenticate.js';
import { authorize } from '../../middleware/authorize.js';
import {
  clockIn,
  clockOut,
  getMyStatus,
  getMyHistory,
  getAllAttendance,
  correctAttendance,
} from './attendance.controller.js';

const adminRoles = ['Super Admin', 'Admin', 'Manager'];

export const attendanceRouter = Router();

attendanceRouter.post('/clock-in',    authenticate, clockIn);
attendanceRouter.post('/clock-out',   authenticate, clockOut);
attendanceRouter.get('/my-status',    authenticate, getMyStatus);
attendanceRouter.get('/my-history',   authenticate, getMyHistory);

attendanceRouter.get('/',             authenticate, authorize(adminRoles), getAllAttendance);
attendanceRouter.patch('/:id',        authenticate, authorize(adminRoles), correctAttendance);
