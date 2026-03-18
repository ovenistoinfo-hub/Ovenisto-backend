/**
 * Outlet Routes
 * GET    /api/outlets      - List all outlets
 * GET    /api/outlets/:id  - Get single outlet
 * POST   /api/outlets      - Create outlet (Admin+)
 * PUT    /api/outlets/:id  - Update outlet (Admin+)
 * DELETE /api/outlets/:id  - Deactivate outlet (Admin+)
 */

import { Router } from 'express';
import { authenticate } from '../../middleware/authenticate.js';
import { authorize } from '../../middleware/authorize.js';
import {
  getOutlets,
  getOutlet,
  createOutlet,
  updateOutlet,
  deleteOutlet,
} from './outlet.controller.js';

const router = Router();

// All outlet routes require authentication
router.use(authenticate);

// List outlets — any authenticated user can see outlets (for dropdowns etc.)
router.get('/', getOutlets);
router.get('/:id', getOutlet);

// Create/Update/Delete — Admin or Super Admin only
router.post('/', authorize(['Super Admin', 'Admin']), createOutlet);
router.put('/:id', authorize(['Super Admin', 'Admin']), updateOutlet);
router.delete('/:id', authorize(['Super Admin', 'Admin']), deleteOutlet);

export default router;
