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
  getUnlinkedEmployees,
  getStaffPicker,
} from './user.controller.js';

const router = Router();

// Roles that can initiate/approve an order cancellation request — same set as the
// orders module's kitchenRoles, since the staff-picker feeds those dropdowns.
const cancellationStaffRoles = [
  'Super Admin', 'Admin', 'Manager', 'Cashier',
  'Kitchen Staff', 'Kitchen Manager', 'Waiter', 'Floor Manager',
];

// All user routes require authenticate
router.use(authenticate);

router.get('/staff-picker', authorize(cancellationStaffRoles), getStaffPicker);
router.get('/unlinked-employees', authorize(['Super Admin', 'Admin', 'Manager']), getUnlinkedEmployees);
router.get('/', authorize(['Super Admin', 'Admin', 'Manager']), validateRequest({ query: userQuerySchema }), getUsers);
router.post('/', authorize(['Super Admin', 'Admin', 'Manager']), validateRequest({ body: createUserSchema }), createUser);

router.get('/:id', authorize(['Super Admin', 'Admin']), getUser);
router.put('/:id', authorize(['Super Admin', 'Admin']), validateRequest({ body: updateUserSchema }), updateUser);
router.delete('/:id', authorize(['Super Admin', 'Admin']), deleteUser);

export default router;
