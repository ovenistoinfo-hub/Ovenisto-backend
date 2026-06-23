/**
 * ProductionItem Routes
 */
import { Router } from 'express';
import { authenticate } from '../../middleware/authenticate.js';
import { authorize } from '../../middleware/authorize.js';
import {
  getProductionItems,
  createProductionItem,
  updateProductionItem,
  deleteProductionItem,
} from './production-items.controller.js';

const router = Router();

router.use(authenticate);

router.get('/', getProductionItems);
router.post('/', authorize(['Super Admin', 'Admin', 'Manager']), createProductionItem);
router.put('/:id', authorize(['Super Admin', 'Admin', 'Manager']), updateProductionItem);
router.delete('/:id', authorize(['Super Admin', 'Admin', 'Manager']), deleteProductionItem);

export default router;
