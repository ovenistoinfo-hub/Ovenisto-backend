import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { validateRequest } from '../../middleware/validateRequest.js';
import { createSelfOrderSchema } from './self-order.schema.js';
import { authenticate } from '../../middleware/authenticate.js';
import { authorize } from '../../middleware/authorize.js';
import {
  getTableForSelfOrder, getSelfOrderMenu, createSelfOrder, getSelfOrderStatus,
  lookupCustomerByPhone, notifySelfOrderSessionEnded,
} from './self-order.controller.js';

export const selfOrderRouter = Router();

const posRoles = ['Super Admin', 'Admin', 'Manager', 'Cashier', 'Waiter', 'Floor Manager'];

// Only the write endpoint is throttled — table lookup, menu, and status poll are
// reads with no abuse potential beyond normal traffic.
const createOrderLimiter = rateLimit({
  windowMs: 60_000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: 'Too many orders placed — please wait a moment and try again.' },
});

// customer-lookup returns a phone -> name match, which is a real customer PII
// disclosure risk if left unthrottled (it's public, no JWT, by design). This is
// a read-only autocomplete-style call the entry gate makes once per "Continue
// to Menu" click (not per keystroke), so a modest per-IP window stops a bulk
// phone-number-sweep without affecting a genuine customer.
const customerLookupLimiter = rateLimit({
  windowMs: 60_000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: 'Too many lookups — please wait a moment and try again.' },
});

// Deliberately public — no `authenticate` on this router. A customer scanning a
// QR code has no JWT. Every handler re-derives outletId from the scanned table;
// nothing here trusts client-sent scope.
selfOrderRouter.get('/table/:tableId', getTableForSelfOrder);
selfOrderRouter.get('/menu', getSelfOrderMenu);
selfOrderRouter.get('/customer-lookup', customerLookupLimiter, lookupCustomerByPhone);
selfOrderRouter.post('/orders', createOrderLimiter, validateRequest({ body: createSelfOrderSchema }), createSelfOrder);
selfOrderRouter.get('/orders/:id/status', getSelfOrderStatus);

// The one staff-authenticated exception in this otherwise-public router: called
// by WaiterPanel's End Sitting action to notify the table's live self-order
// session (if any) that it has ended.
selfOrderRouter.post('/table/:tableId/end-session', authenticate, authorize(posRoles), notifySelfOrderSessionEnded);
