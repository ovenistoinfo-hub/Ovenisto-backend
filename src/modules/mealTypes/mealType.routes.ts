/**
 * Meal Type Routes
 */

import { Router } from 'express';
import { authenticate } from '../../middleware/authenticate.js';
import { authorize } from '../../middleware/authorize.js';
import { getMealTypes, createMealType, updateMealType, deleteMealType } from './mealType.controller.js';

const router = Router();

router.use(authenticate);

router.get('/', getMealTypes);
router.post('/', authorize(['Super Admin', 'Admin', 'Manager']), createMealType);
router.put('/:id', authorize(['Super Admin', 'Admin', 'Manager']), updateMealType);
router.delete('/:id', authorize(['Super Admin', 'Admin', 'Manager']), deleteMealType);

export { router as mealTypeRouter };
