/**
 * Warehouse Routes
 */

import { Router } from 'express';
import { authenticate } from '../../middleware/authenticate.js';
import { authorize } from '../../middleware/authorize.js';
import {
  getWarehouses,
  getWarehouse,
  getWarehouseStock,
  getWarehouseConsumption,
  createWarehouse,
  updateWarehouse,
  deleteWarehouse,
} from './warehouse.controller.js';

const router = Router();
const adminRoles = ['Super Admin', 'Admin', 'Manager', 'Store Manager'];

router.get('/', authenticate, getWarehouses);
router.get('/:id', authenticate, getWarehouse);
router.get('/:id/stock',       authenticate, getWarehouseStock);
router.get('/:id/consumption', authenticate, getWarehouseConsumption);
router.post('/', authenticate, authorize(adminRoles), createWarehouse);
router.put('/:id', authenticate, authorize(adminRoles), updateWarehouse);
router.delete('/:id', authenticate, authorize(['Super Admin', 'Admin']), deleteWarehouse);

export { router as warehouseRouter };
