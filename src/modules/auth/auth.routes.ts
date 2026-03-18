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
import { validateRequest } from '../../middleware/validateRequest.js';
import {
  loginSchema,
  updateProfileSchema,
  changePasswordSchema,
  refreshTokenSchema,
} from './auth.schema.js';
import {
  login,
  logout,
  getMe,
  updateMe,
  changePassword,
  refreshAccessToken,
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

export default router;
