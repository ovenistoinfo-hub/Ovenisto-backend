import { Router } from 'express';
import {
  getTableForSelfOrder, getSelfOrderMenu, createSelfOrder, getSelfOrderStatus,
} from './self-order.controller.js';

export const selfOrderRouter = Router();

// Deliberately public — no `authenticate` on this router. A customer scanning a
// QR code has no JWT. Every handler re-derives outletId from the scanned table;
// nothing here trusts client-sent scope.
selfOrderRouter.get('/table/:tableId', getTableForSelfOrder);
selfOrderRouter.get('/menu', getSelfOrderMenu);
selfOrderRouter.post('/orders', createSelfOrder);
selfOrderRouter.get('/orders/:id/status', getSelfOrderStatus);
