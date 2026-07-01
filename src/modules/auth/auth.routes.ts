/**
 * Auth Routes
 * POST /api/auth/login      - Login
 * POST /api/auth/logout     - Logout
 * GET  /api/auth/me         - Get current user profile
 * PUT  /api/auth/me         - Update own profile
 * PUT  /api/auth/change-password - Change own password
 * POST /api/auth/refresh    - Refresh JWT token
 */

import { Router } from 'express';
import { authenticate } from '../../middleware/authenticate.js';
import { authorize } from '../../middleware/authorize.js';
import { validateRequest } from '../../middleware/validateRequest.js';
import {
  loginSchema,
  updateProfileSchema,
  changePasswordSchema,
  refreshTokenSchema,
  setPinSchema,
} from './auth.schema.js';
import {
  login,
  logout,
  getMe,
  updateMe,
  changePassword,
  refreshAccessToken,
  setPin,
} from './auth.controller.js';

const router = Router();

// Public routes
router.post('/login', validateRequest({ body: loginSchema }), login);
router.post('/refresh', validateRequest({ body: refreshTokenSchema }), refreshAccessToken);

// Protected routes
router.post('/logout', authenticate, logout);
router.get('/me', authenticate, getMe);
router.put('/me', authenticate, validateRequest({ body: updateProfileSchema }), updateMe);
router.put(
  '/change-password',
  authenticate,
  validateRequest({ body: changePasswordSchema }),
  changePassword
);

router.put(
  '/pin',
  authenticate,
  authorize(['Super Admin', 'Admin', 'Manager', 'Floor Manager']),
  validateRequest({ body: setPinSchema }),
  setPin
);

export default router;
