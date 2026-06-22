/**
 * Table Routes
 */

import { Router } from 'express';
import { authenticate } from '../../middleware/authenticate.js';
import { authorize } from '../../middleware/authorize.js';
import { getTables, createTable, updateTable, deleteTable } from './table.controller.js';

const router = Router();

// Staff floor management (the self-order kiosk reads its table number from the URL, not this endpoint)
router.get('/', authenticate, getTables);

// Protected — Admin/Manager only
router.post('/', authenticate, authorize(['Super Admin', 'Admin', 'Manager']), createTable);
router.put('/:id', authenticate, authorize(['Super Admin', 'Admin', 'Manager']), updateTable);
router.delete('/:id', authenticate, authorize(['Super Admin', 'Admin', 'Manager']), deleteTable);

export default router;
