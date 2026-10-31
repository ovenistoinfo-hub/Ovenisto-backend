import { Router } from 'express';
import { authenticate } from '../../middleware/authenticate.js';
import { authorize } from '../../middleware/authorize.js';
import {
  getSuppliers,
  getSupplier,
  createSupplier,
  updateSupplier,
  deleteSupplier,
  recordPayment,
  getSupplierIngredients,
  getSupplierLedger,
} from './supplier.controller.js';

const writeRoles = ['Super Admin', 'Admin', 'Manager', 'Store Manager', 'Accountant'];
// Kitchen Manager reads the list for the Ingredients and Kitchen Stock screens.
const readRoles = [...writeRoles, 'Kitchen Manager'];

export const suppliersRouter = Router();

suppliersRouter.get('/',                authenticate, authorize(readRoles), getSuppliers);
suppliersRouter.get('/:id/ingredients', authenticate, authorize(readRoles), getSupplierIngredients);
suppliersRouter.get('/:id/ledger',      authenticate, authorize(readRoles), getSupplierLedger);
suppliersRouter.get('/:id',             authenticate, authorize(readRoles), getSupplier);
suppliersRouter.post('/',               authenticate, authorize(writeRoles), createSupplier);
suppliersRouter.put('/:id',             authenticate, authorize(writeRoles), updateSupplier);
suppliersRouter.delete('/:id',          authenticate, authorize(writeRoles), deleteSupplier);
suppliersRouter.post('/:id/payment',    authenticate, authorize(writeRoles), recordPayment);
