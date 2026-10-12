import { Router } from 'express';
import { authenticate } from '../../middleware/authenticate.js';
import { authorize } from '../../middleware/authorize.js';
import { WEBSITE_ORDER_APPROVER_ROLES } from '../order/order.acceptance.js';
import { safepayReturn, safepayWebhook, getRefundsDue, postRefunded } from './payment.controller.js';

export const paymentsRouter = Router();

// Safepay calls these (the customer's browser, and Safepay's server): no staff login, the signature is the check.
paymentsRouter.post('/safepay/return', safepayReturn);
paymentsRouter.post('/safepay/webhook', safepayWebhook);

// Whoever may decline a website order may also record its refund.
paymentsRouter.get('/refunds-due', authenticate, authorize(WEBSITE_ORDER_APPROVER_ROLES), getRefundsDue);
paymentsRouter.post('/:id/refunded', authenticate, authorize(WEBSITE_ORDER_APPROVER_ROLES), postRefunded);
