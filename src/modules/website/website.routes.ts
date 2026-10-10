import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { getOutlets, getConfig, getMenu, getDeals, quoteCart, createWebsiteOrder, getWebsiteOrderStatus, createWebsiteReservation, getWebsiteReservationStatus, quoteWebsiteReservation, getMyWebsiteOrders, getMyWebsiteReservations } from './website.controller.js';
import { requireWebsiteCustomer } from './website.auth.js';
import { validateRequest } from '../../middleware/validateRequest.js';
import { quoteCartSchema, createOrderSchema, reservationSchema, quoteReservationSchema } from './website.schema.js';

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

websiteRouter.get('/outlets', readLimiter, getOutlets);
websiteRouter.get('/config', readLimiter, getConfig);
websiteRouter.get('/menu', readLimiter, getMenu);
websiteRouter.get('/deals', readLimiter, getDeals);

websiteRouter.post('/quote', quoteLimiter, validateRequest({ body: quoteCartSchema }), quoteCart);
// Placing an order or a booking needs a signed-in customer (Firebase ID token); browsing and quotes don't.
websiteRouter.post('/orders', orderLimiter, requireWebsiteCustomer, validateRequest({ body: createOrderSchema }), createWebsiteOrder);
websiteRouter.get('/orders/:id/status', readLimiter, getWebsiteOrderStatus);

websiteRouter.post('/reservations/quote', quoteLimiter, validateRequest({ body: quoteReservationSchema }), quoteWebsiteReservation);
websiteRouter.post('/reservations', reservationLimiter, requireWebsiteCustomer, validateRequest({ body: reservationSchema }), createWebsiteReservation);
websiteRouter.get('/reservations/:id/status', readLimiter, getWebsiteReservationStatus);

websiteRouter.get('/my/orders', readLimiter, requireWebsiteCustomer, getMyWebsiteOrders);
websiteRouter.get('/my/reservations', readLimiter, requireWebsiteCustomer, getMyWebsiteReservations);

