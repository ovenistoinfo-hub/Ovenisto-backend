/**
 * Table Routes
 */

import { Router } from 'express';
import { authenticate } from '../../middleware/authenticate.js';
import { authorize } from '../../middleware/authorize.js';
import { getTables, createTable, updateTable, deleteTable } from './table.controller.js';

const router = Router();

// Public — used by self-order kiosk (no auth required)
router.get('/', getTables);

// Protected — Admin/Manager only
router.post('/', authenticate, authorize(['Super Admin', 'Admin', 'Manager']), createTable);
router.put('/:id', authenticate, authorize(['Super Admin', 'Admin', 'Manager']), updateTable);
router.delete('/:id', authenticate, authorize(['Super Admin', 'Admin', 'Manager']), deleteTable);

export default router;
