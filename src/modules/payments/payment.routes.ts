import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { authenticate } from '../../middleware/authenticate.js';
import { authorize } from '../../middleware/authorize.js';
import { WEBSITE_ORDER_APPROVER_ROLES } from '../order/order.acceptance.js';
import { safepayReturn, safepayWebhook, getRefundsDue, postRefunded } from './payment.controller.js';

export const paymentsRouter = Router();

// The customer's browser hits the return, so it is throttled per IP. The webhook is not: its HMAC check
// runs before any DB work, so a flood of forged calls costs a hash, not a query.
const returnLimiter = rateLimit({
  windowMs: 60_000,
  limit: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: 'Too many requests - please wait a moment and try again.' },
});

// Safepay calls these (the customer's browser, and Safepay's server): no staff login. The return arrives as a
// GET with no signature (seen in the sandbox), so its handler asks Safepay itself; POST is kept for the SDK's flow.
paymentsRouter.get('/safepay/return', returnLimiter, safepayReturn);
paymentsRouter.post('/safepay/return', returnLimiter, safepayReturn);
paymentsRouter.post('/safepay/webhook', safepayWebhook);

// Whoever may decline a website order may also record its refund.
paymentsRouter.get('/refunds-due', authenticate, authorize(WEBSITE_ORDER_APPROVER_ROLES), getRefundsDue);
paymentsRouter.post('/:id/refunded', authenticate, authorize(WEBSITE_ORDER_APPROVER_ROLES), postRefunded);
