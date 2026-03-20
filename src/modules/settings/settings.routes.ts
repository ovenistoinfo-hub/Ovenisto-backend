/**
 * Settings Routes
 * GET    /api/settings - Get settings
 * PUT    /api/settings - Update settings (Admin+)
 */

import { Router } from 'express';
import { authenticate } from '../../middleware/authenticate.js';
import { authorize } from '../../middleware/authorize.js';
import { validateRequest } from '../../middleware/validateRequest.js';
import { getSettings, updateSettings } from './settings.controller.js';
import { updateSettingsSchema } from './settings.schema.js';

const router = Router();

// Retrieve settings — public (currency, tax rate, restaurant name are not sensitive)
router.get('/', getSettings);

// Update settings (Admin/Super Admin only)
router.put(
  '/',
  authenticate,
  authorize(['Super Admin', 'Admin']),
  validateRequest({ body: updateSettingsSchema }),
  updateSettings
);

export default router;
