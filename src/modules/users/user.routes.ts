/**
 * User Routes
 * GET    /api/users      - List all users (Admin+)
 * GET    /api/users/:id  - Get single user (Admin+)
 * POST   /api/users      - Create user (Admin+)
 * PUT    /api/users/:id  - Update user (Admin+)
 * DELETE /api/users/:id  - Deactivate user (Admin+)
 */

import { Router } from 'express';
import { authenticate } from '../../middleware/authenticate.js';
import { authorize } from '../../middleware/authorize.js';
import { validateRequest } from '../../middleware/validateRequest.js';
import { createUserSchema, updateUserSchema, userQuerySchema } from '../auth/auth.schema.js';
import {
  getUsers,
  getUser,
  createUser,
  updateUser,
  deleteUser,
} from './user.controller.js';

const router = Router();

// All user routes require Admin or Super Admin
router.use(authenticate, authorize(['Super Admin', 'Admin']));

router.get('/', validateRequest({ query: userQuerySchema }), getUsers);
router.get('/:id', getUser);
router.post('/', validateRequest({ body: createUserSchema }), createUser);
router.put('/:id', validateRequest({ body: updateUserSchema }), updateUser);
router.delete('/:id', deleteUser);

export default router;
