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

export const expensesRouter = Router();

expensesRouter.get('/',       authenticate, getExpenses);
expensesRouter.get('/:id',    authenticate, getExpense);
expensesRouter.post('/',      authenticate, authorize(writeRoles), createExpense);
expensesRouter.put('/:id',    authenticate, authorize(writeRoles), updateExpense);
expensesRouter.delete('/:id', authenticate, authorize(writeRoles), deleteExpense);
