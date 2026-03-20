import { Router } from 'express';
import { authenticate } from '../../middleware/authenticate.js';
import { authorize } from '../../middleware/authorize.js';
import { getCustomers, getCustomer, createCustomer, updateCustomer, deleteCustomer } from './customer.controller.js';

const writeRoles = ['Super Admin', 'Admin', 'Manager', 'Cashier'];
const adminRoles = ['Super Admin', 'Admin'];

export const customersRouter = Router();

customersRouter.get('/',     authenticate, getCustomers);
customersRouter.get('/:id',  authenticate, getCustomer);
customersRouter.post('/',    authenticate, authorize(writeRoles), createCustomer);
customersRouter.put('/:id',  authenticate, authorize(writeRoles), updateCustomer);
customersRouter.delete('/:id', authenticate, authorize(adminRoles), deleteCustomer);
