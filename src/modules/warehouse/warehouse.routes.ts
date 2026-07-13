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
  getWarehouseExpirySummary,
  createWarehouse,
  updateWarehouse,
  deleteWarehouse,
  getWarehouseDashboard,
} from './warehouse.controller.js';
import { WAREHOUSE_DASHBOARD_ROLES } from './warehouse.access.js';

const router = Router();
const adminRoles = ['Super Admin', 'Admin', 'Manager', 'Store Manager'];

router.get('/', authenticate, getWarehouses);
// Must stay registered BEFORE '/:id', or Express reads "dashboard-stats" as an id.
router.get(
  '/dashboard-stats',
  authenticate,
  authorize(WAREHOUSE_DASHBOARD_ROLES),
  getWarehouseDashboard
);
router.get('/:id', authenticate, getWarehouse);
router.get('/:id/stock',          authenticate, getWarehouseStock);
router.get('/:id/expiry-summary', authenticate, getWarehouseExpirySummary);
router.get('/:id/consumption',    authenticate, getWarehouseConsumption);
router.post('/', authenticate, authorize(adminRoles), createWarehouse);
router.put('/:id', authenticate, authorize(adminRoles), updateWarehouse);
router.delete('/:id', authenticate, authorize(['Super Admin', 'Admin']), deleteWarehouse);

export { router as warehouseRouter };
