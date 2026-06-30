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

export const employeesRouter = Router();

// Specific paths BEFORE /:id to avoid Express param shadowing.
employeesRouter.get('/me',          authenticate, getMyEmployee);
employeesRouter.get('/supervisors', authenticate, getSupervisorOptions);
employeesRouter.get('/',            authenticate, getEmployees);
employeesRouter.get('/:id',         authenticate, getEmployee);
employeesRouter.post('/',           authenticate, authorize(writeRoles), createEmployee);
employeesRouter.put('/:id',         authenticate, authorize(writeRoles), updateEmployee);
employeesRouter.delete('/:id',      authenticate, authorize(writeRoles), deleteEmployee);
