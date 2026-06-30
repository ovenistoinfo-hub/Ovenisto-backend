import { Router } from 'express';
import { authenticate } from '../../middleware/authenticate.js';
import { authorize } from '../../middleware/authorize.js';
import {
  getEmployees,
  getEmployee,
  getMyEmployee,
  getSupervisorOptions,
  createEmployee,
  updateEmployee,
  deleteEmployee,
} from './employee.controller.js';

const writeRoles = ['Super Admin', 'Admin', 'Manager', 'Store Manager'];
const adminRoles = ['Super Admin', 'Admin'];

export const employeesRouter = Router();

// Specific paths BEFORE /:id to avoid Express param shadowing.
employeesRouter.get('/me',          authenticate, getMyEmployee);
employeesRouter.get('/supervisors', authenticate, getSupervisorOptions);
employeesRouter.get('/',            authenticate, getEmployees);
employeesRouter.get('/:id',         authenticate, getEmployee);
employeesRouter.post('/',           authenticate, authorize(writeRoles), createEmployee);
employeesRouter.put('/:id',         authenticate, authorize(adminRoles), updateEmployee);
employeesRouter.delete('/:id',      authenticate, authorize(adminRoles), deleteEmployee);
