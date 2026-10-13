import type { Request, Response } from 'express';
import { asyncHandler } from '../../utils/asyncHandler.js';
import { ApiError } from '../../utils/ApiError.js';
import { ApiResponse } from '../../utils/ApiResponse.js';
import { resolveOutletScope } from '../../middleware/outletScope.js';
import { prisma } from '../../config/database.js';
import { isValidWebhookSignature } from './safepay.js';
import { webhookTracker } from './payment.rules.js';
import { safepayConfig, confirmPayment, settlePayment, listRefundsDue, markRefunded } from './payment.service.js';

/**
 * GET (or POST) /api/payments/safepay/return?pid= — Safepay sends the customer's browser here after checkout.
 * Seen in the sandbox: a GET with no signature, and "?order_id=…&tracker=…" appended even though our URL
 * already has a query, so `pid` arrives as "<id>?order_id=…". Nothing in the request is trusted: the
 * payment counts only if Safepay's own record says it was paid (settlePayment).
 */
export const safepayReturn = asyncHandler(async (req: Request, res: Response) => {
  const pid = typeof req.query.pid === 'string' ? req.query.pid.split('?')[0] : '';
  const rawTracker = req.body?.tracker ?? req.query.tracker;
  let payment = pid ? await prisma.orderPayment.findUnique({ where: { id: pid } }) : null;
  if (!payment && typeof rawTracker === 'string' && rawTracker.length > 0) {
    payment = await prisma.orderPayment.findUnique({ where: { tracker: rawTracker } });
  }
  if (!payment || !payment.returnOrigin) throw ApiError.notFound('Payment not found');

  // Paid at Safepay means "done" even if saving it failed here: the order page's next status check saves it.
  const paid = payment.status === 'paid' || (await settlePayment(payment)) === 'paid';
  if (!paid) console.warn(`[safepay] return for payment ${payment.id}: Safepay does not report it paid`);

  res.redirect(303, `${payment.returnOrigin}/order/${payment.orderId}?payment=${paid ? 'done' : 'failed'}`);
});

/** POST /api/payments/safepay/webhook — Safepay's server-to-server notice. */
export const safepayWebhook = asyncHandler(async (req: Request, res: Response) => {
  if (!safepayConfig || !isValidWebhookSignature(safepayConfig, req.body?.data, req.get('x-sfpy-signature'))) {
    console.warn('[safepay] webhook with a bad signature');
    throw ApiError.unauthorized('Invalid signature');
  }
  const tracker = webhookTracker(req.body);
  if (tracker) await confirmPayment(tracker);
  else console.info('[safepay] webhook ignored:', String(req.body?.type ?? 'no type'));
  res.json(ApiResponse.success({ received: true }));
});

/** GET /api/payments/refunds-due — website payments with money owed back (Order Monitor inbox). */
export const getRefundsDue = asyncHandler(async (req: Request, res: Response) => {
  res.json(ApiResponse.success(await listRefundsDue(resolveOutletScope(req))));
});

/** POST /api/payments/:id/refunded { reference? } — staff refunded it from the Safepay dashboard. */
export const postRefunded = asyncHandler(async (req: Request, res: Response) => {
  const raw = req.body?.reference;
  const reference = typeof raw === 'string' && raw.trim() ? raw.trim().slice(0, 100) : null;
  const result = await markRefunded(req.params.id, resolveOutletScope(req), req.user, reference);
  res.json(ApiResponse.success(result, 'Refund recorded'));
});
