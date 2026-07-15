/**
 * Inventory Routes
 * Phase 3/4: Ingredient Units, Ingredient Categories, Ingredients, Pre-Made Food
 */

import { Router } from 'express';
import { authenticate } from '../../middleware/authenticate.js';
import { authorize } from '../../middleware/authorize.js';
import {
  getUnits, createUnit, updateUnit, deleteUnit,
  getIngredientCategories, createIngredientCategory, updateIngredientCategory, deleteIngredientCategory,
  getIngredients, getIngredient, createIngredient, updateIngredient, deleteIngredient,
  getPreMadeFood, createPreMadeFood, updatePreMadeFood, deletePreMadeFood,
} from './inventory.controller.js';

const router = Router();
const adminRoles = ['Super Admin', 'Admin', 'Manager', 'Store Manager'];

// ── Ingredient Units ──
router.get('/units', authenticate, getUnits);
router.post('/units', authenticate, authorize(adminRoles), createUnit);
router.put('/units/:id', authenticate, authorize(adminRoles), updateUnit);
router.delete('/units/:id', authenticate, authorize(adminRoles), deleteUnit);

// ── Ingredient Categories ──
router.get('/ingredient-categories', authenticate, getIngredientCategories);
router.post('/ingredient-categories', authenticate, authorize(adminRoles), createIngredientCategory);
router.put('/ingredient-categories/:id', authenticate, authorize(adminRoles), updateIngredientCategory);
router.delete('/ingredient-categories/:id', authenticate, authorize(adminRoles), deleteIngredientCategory);

// ── Ingredients ──
router.get('/ingredients', authenticate, getIngredients);
router.get('/ingredients/:id', authenticate, getIngredient);
router.post('/ingredients', authenticate, authorize(adminRoles), createIngredient);
router.put('/ingredients/:id', authenticate, authorize(adminRoles), updateIngredient);
router.delete('/ingredients/:id', authenticate, authorize(adminRoles), deleteIngredient);

// ── Pre-Made Food ──
router.get('/pre-made', authenticate, getPreMadeFood);
router.post('/pre-made', authenticate, authorize(adminRoles), createPreMadeFood);
router.put('/pre-made/:id', authenticate, authorize(adminRoles), updatePreMadeFood);
router.delete('/pre-made/:id', authenticate, authorize(adminRoles), deletePreMadeFood);

export default router;
