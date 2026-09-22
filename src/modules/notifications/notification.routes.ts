/**
 * Notification Routes
 */

import { Router } from 'express';
import { authenticate } from '../../middleware/authenticate.js';
import { registerDeviceToken, deleteDeviceToken } from './notification.controller.js';

const router = Router();

router.use(authenticate);

router.post('/device-token', registerDeviceToken);
router.delete('/device-token', deleteDeviceToken);

export { router as notificationRouter };
