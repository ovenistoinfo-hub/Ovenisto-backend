/**
 * Table Routes
 */

import { Router } from 'express';
import { authenticate } from '../../middleware/authenticate.js';
import { requirePermission } from '../../middleware/authorize.js';
import { getTables, createTable, updateTable, deleteTable } from './table.controller.js';

const router = Router();

// Staff floor management (the self-order kiosk reads its table number from the URL, not this endpoint)
router.get('/', authenticate, getTables);

// Protected — table-layout permission required
router.post('/', authenticate, requirePermission('table-layout'), createTable);
router.put('/:id', authenticate, updateTable);
router.delete('/:id', authenticate, requirePermission('table-layout'), deleteTable);

export default router;
