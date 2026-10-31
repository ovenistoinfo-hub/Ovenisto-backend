import { Router } from 'express';
import { authenticate } from '../../middleware/authenticate.js';
import { authorize } from '../../middleware/authorize.js';
import {
  getExpenses,
  getExpense,
  createExpense,
  updateExpense,
  deleteExpense,
} from './expense.controller.js';

const writeRoles = ['Super Admin', 'Admin', 'Manager', 'Accountant'];
const readRoles = writeRoles;

export const expensesRouter = Router();

expensesRouter.get('/',       authenticate, authorize(readRoles), getExpenses);
expensesRouter.get('/:id',    authenticate, authorize(readRoles), getExpense);
expensesRouter.post('/',      authenticate, authorize(writeRoles), createExpense);
expensesRouter.put('/:id',    authenticate, authorize(writeRoles), updateExpense);
expensesRouter.delete('/:id', authenticate, authorize(writeRoles), deleteExpense);
