import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { validateRequest } from '../../middleware/validateRequest.js';
import { createSelfOrderSchema } from './self-order.schema.js';
import {
  getTableForSelfOrder, getSelfOrderMenu, createSelfOrder, getSelfOrderStatus,
} from './self-order.controller.js';

export const selfOrderRouter = Router();

// Only the write endpoint is throttled — table lookup, menu, and status poll are
// reads with no abuse potential beyond normal traffic.
const createOrderLimiter = rateLimit({
  windowMs: 60_000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: 'Too many orders placed — please wait a moment and try again.' },
});

// Deliberately public — no `authenticate` on this router. A customer scanning a
// QR code has no JWT. Every handler re-derives outletId from the scanned table;
// nothing here trusts client-sent scope.
selfOrderRouter.get('/table/:tableId', getTableForSelfOrder);
selfOrderRouter.get('/menu', getSelfOrderMenu);
selfOrderRouter.post('/orders', createOrderLimiter, validateRequest({ body: createSelfOrderSchema }), createSelfOrder);
selfOrderRouter.get('/orders/:id/status', getSelfOrderStatus);
