/**
 * Menu Routes
 * Phase 3: Food Categories, Menu Items, Modifiers, Recipes
 */

import { Router } from 'express';
import { authenticate } from '../../middleware/authenticate.js';
import { authorize } from '../../middleware/authorize.js';
import {
  getCategories, createCategory, updateCategory, deleteCategory,
  getMenuItems, getMenuItem, createMenuItem, updateMenuItem, deleteMenuItem,
  getModifiers, createModifier, updateModifier, deleteModifier,
  getRecipe, updateRecipe,
} from './menu.controller.js';

const router = Router();
const adminRoles = ['Super Admin', 'Admin', 'Manager'];

// ── Categories ──
router.get('/categories', authenticate, getCategories);
router.post('/categories', authenticate, authorize(adminRoles), createCategory);
router.put('/categories/:id', authenticate, authorize(adminRoles), updateCategory);
router.delete('/categories/:id', authenticate, authorize(adminRoles), deleteCategory);

// ── Menu Items ──
router.get('/items', authenticate, getMenuItems);
router.get('/items/:id', authenticate, getMenuItem);
router.post('/items', authenticate, authorize(adminRoles), createMenuItem);
router.put('/items/:id', authenticate, authorize(adminRoles), updateMenuItem);
router.delete('/items/:id', authenticate, authorize(adminRoles), deleteMenuItem);

// ── Recipes (per item) ──
router.get('/items/:id/recipe', authenticate, getRecipe);
router.put('/items/:id/recipe', authenticate, authorize(adminRoles), updateRecipe);

// ── Modifiers ──
router.get('/modifiers', authenticate, getModifiers);
router.post('/modifiers', authenticate, authorize(adminRoles), createModifier);
router.put('/modifiers/:id', authenticate, authorize(adminRoles), updateModifier);
router.delete('/modifiers/:id', authenticate, authorize(adminRoles), deleteModifier);

export default router;
