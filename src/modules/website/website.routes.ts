import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { getOutlets, getConfig, getMenu, getDeals, quoteCart, createWebsiteOrder, getWebsiteOrderStatus, createWebsiteReservation, getWebsiteReservationStatus, quoteWebsiteReservation, getMyWebsiteOrders, getMyWebsiteReservations, payWebsiteOrder, payCashWebsiteOrder, getBestSellers, getComingSoon, voteComingSoon, createDishSuggestion, createEventInquiry, getKitchenPosts, getKitchenPost } from './website.controller.js';
import { requireWebsiteCustomer, optionalWebsiteCustomer } from './website.auth.js';
import { validateRequest } from '../../middleware/validateRequest.js';
import { quoteCartSchema, createOrderSchema, reservationSchema, quoteReservationSchema, suggestionSchema, eventInquirySchema, passwordResetRequestSchema, passwordResetVerifySchema, passwordResetConfirmSchema } from './website.schema.js';
import { requestPasswordReset, verifyPasswordResetCode, confirmPasswordReset } from './website.passwordReset.js';

export const websiteRouter = Router();

const readLimiter = rateLimit({
  windowMs: 60_000,
  limit: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: 'Too many requests - please wait a moment and try again.' },
});

const quoteLimiter = rateLimit({
  windowMs: 60_000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: 'Too many requests - please wait a moment and try again.' },
});

const orderLimiter = rateLimit({
  windowMs: 60_000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: 'Too many requests - please wait a moment and try again.' },
});

const reservationLimiter = rateLimit({
  windowMs: 60_000,
  limit: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: 'Too many requests - please wait a moment and try again.' },
});

// Suggestions and event quote requests: a few per minute is plenty for a person.
const formLimiter = rateLimit({
  windowMs: 60_000,
  limit: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: 'Too many requests - please wait a moment and try again.' },
});

const voteLimiter = rateLimit({
  windowMs: 60_000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: 'Too many requests - please wait a moment and try again.' },
});

// Forgot password: a code by email. Tight per-IP limits are what keep a 6-digit code from being guessed.
const resetRequestLimiter = rateLimit({
  windowMs: 15 * 60_000,
  limit: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: 'Too many reset requests - please wait 15 minutes and try again.' },
});
const resetCodeLimiter = rateLimit({
  windowMs: 15 * 60_000,
  limit: 15,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: 'Too many tries - please wait 15 minutes and ask for a new code.' },
});

websiteRouter.post('/auth/password-reset', resetRequestLimiter, validateRequest({ body: passwordResetRequestSchema }), requestPasswordReset);
websiteRouter.post('/auth/password-reset/verify', resetCodeLimiter, validateRequest({ body: passwordResetVerifySchema }), verifyPasswordResetCode);
websiteRouter.post('/auth/password-reset/confirm', resetCodeLimiter, validateRequest({ body: passwordResetConfirmSchema }), confirmPasswordReset);

websiteRouter.get('/outlets', readLimiter, getOutlets);
websiteRouter.get('/config', readLimiter, getConfig);
websiteRouter.get('/menu', readLimiter, getMenu);
websiteRouter.get('/deals', readLimiter, getDeals);

websiteRouter.post('/quote', quoteLimiter, optionalWebsiteCustomer, validateRequest({ body: quoteCartSchema }), quoteCart);
// Placing an order or a booking needs a signed-in customer (Firebase ID token); browsing and quotes don't.
websiteRouter.post('/orders', orderLimiter, requireWebsiteCustomer, validateRequest({ body: createOrderSchema }), createWebsiteOrder);
websiteRouter.post('/orders/:id/pay', orderLimiter, requireWebsiteCustomer, payWebsiteOrder);
websiteRouter.post('/orders/:id/pay-cash', orderLimiter, requireWebsiteCustomer, payCashWebsiteOrder);
websiteRouter.get('/orders/:id/status', readLimiter, getWebsiteOrderStatus);

websiteRouter.post('/reservations/quote', quoteLimiter, validateRequest({ body: quoteReservationSchema }), quoteWebsiteReservation);
websiteRouter.post('/reservations', reservationLimiter, requireWebsiteCustomer, validateRequest({ body: reservationSchema }), createWebsiteReservation);
websiteRouter.get('/reservations/:id/status', readLimiter, getWebsiteReservationStatus);

websiteRouter.get('/my/orders', readLimiter, requireWebsiteCustomer, getMyWebsiteOrders);
websiteRouter.get('/my/reservations', readLimiter, requireWebsiteCustomer, getMyWebsiteReservations);

websiteRouter.get('/best-sellers', readLimiter, getBestSellers);
websiteRouter.get('/coming-soon', readLimiter, getComingSoon);
websiteRouter.post('/coming-soon/:id/vote', voteLimiter, voteComingSoon);
websiteRouter.get('/kitchen-posts', readLimiter, getKitchenPosts);
websiteRouter.get('/kitchen-posts/:id', readLimiter, getKitchenPost);
websiteRouter.post('/suggestions', formLimiter, validateRequest({ body: suggestionSchema }), createDishSuggestion);
websiteRouter.post('/event-inquiries', formLimiter, validateRequest({ body: eventInquirySchema }), createEventInquiry);

