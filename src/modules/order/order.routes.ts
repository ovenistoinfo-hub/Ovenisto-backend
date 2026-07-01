/**
 * Order & Kitchen Routes
 * Phase 5: Orders & POS
 */

import { Router } from 'express';
import { authenticate } from '../../middleware/authenticate.js';
import { authorize } from '../../middleware/authorize.js';
import {
  getOrders, getOrder, createOrder, updateOrder, updateOrderStatus, cancelOrder, deleteOrder,
  getKitchens, createKitchen, updateKitchen, deleteKitchen,
} from './order.controller.js';

const adminRoles = ['Super Admin', 'Admin', 'Manager'];
const posRoles = ['Super Admin', 'Admin', 'Manager', 'Cashier', 'Waiter', 'Floor Manager'];
const kitchenRoles = [
  'Super Admin', 'Admin', 'Manager', 'Cashier',
  'Kitchen Staff', 'Kitchen Manager', 'Waiter', 'Floor Manager',
];

// ── Orders router ──
export const ordersRouter = Router();
ordersRouter.get('/', authenticate, getOrders);
ordersRouter.get('/:id', authenticate, getOrder);
ordersRouter.post('/', authenticate, authorize(posRoles), createOrder);
ordersRouter.put('/:id/status', authenticate, authorize(kitchenRoles), updateOrderStatus);
ordersRouter.post('/:id/cancel', authenticate, authorize(kitchenRoles), cancelOrder);
ordersRouter.put('/:id', authenticate, authorize(posRoles), updateOrder);
ordersRouter.delete('/:id', authenticate, authorize(adminRoles), deleteOrder);

// ── Kitchens router ──
export const kitchensRouter = Router();
kitchensRouter.get('/', authenticate, getKitchens);
kitchensRouter.post('/', authenticate, authorize(adminRoles), createKitchen);
kitchensRouter.put('/:id', authenticate, authorize(adminRoles), updateKitchen);
kitchensRouter.delete('/:id', authenticate, authorize(adminRoles), deleteKitchen);
