import type { Request, Response } from 'express';
import { asyncHandler } from '../../utils/asyncHandler.js';
import { ApiError } from '../../utils/ApiError.js';
import { ApiResponse } from '../../utils/ApiResponse.js';
import { resolveOutletScope } from '../../middleware/outletScope.js';
import { prisma } from '../../config/database.js';
import { isValidReturnSignature, isValidWebhookSignature } from './safepay.js';
import { webhookTracker } from './payment.rules.js';
import { safepayConfig, confirmPayment, listRefundsDue, markRefunded } from './payment.service.js';

/** POST /api/payments/safepay/return?pid= — Safepay posts the customer's browser here after checkout. */
export const safepayReturn = asyncHandler(async (req: Request, res: Response) => {
  const pid = typeof req.query.pid === 'string' ? req.query.pid : '';
  const payment = pid ? await prisma.orderPayment.findUnique({ where: { id: pid } }) : null;
  if (!payment || !payment.returnOrigin) throw ApiError.notFound('Payment not found');

  const tracker = req.body?.tracker;
  const ok = !!safepayConfig && tracker === payment.tracker && isValidReturnSignature(safepayConfig, tracker, req.body?.sig);
  if (ok) {
    // The customer has paid: whatever happens to the save, they go back to the order page (it polls and
    // says it is confirming), and the webhook confirms the payment if this attempt failed.
    try {
      await confirmPayment(payment.tracker);
    } catch (err) {
      console.error(`[safepay] confirming payment ${payment.id} on return failed; the webhook will retry`, err);
    }
  } else {
    const reason = !safepayConfig ? 'Safepay keys are not set' : tracker !== payment.tracker ? 'tracker does not match' : 'bad signature';
    console.warn(`[safepay] return rejected for payment ${payment.id}: ${reason}`);
  }

  res.redirect(303, `${payment.returnOrigin}/order/${payment.orderId}?payment=${ok ? 'done' : 'failed'}`);
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
