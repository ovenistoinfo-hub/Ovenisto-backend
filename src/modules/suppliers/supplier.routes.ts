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

export const suppliersRouter = Router();

suppliersRouter.get('/',                authenticate, getSuppliers);
suppliersRouter.get('/:id/ingredients', authenticate, getSupplierIngredients);
suppliersRouter.get('/:id/ledger',      authenticate, getSupplierLedger);
suppliersRouter.get('/:id',             authenticate, getSupplier);
suppliersRouter.post('/',               authenticate, authorize(writeRoles), createSupplier);
suppliersRouter.put('/:id',             authenticate, authorize(writeRoles), updateSupplier);
suppliersRouter.delete('/:id',          authenticate, authorize(writeRoles), deleteSupplier);
suppliersRouter.post('/:id/payment',    authenticate, authorize(writeRoles), recordPayment);
