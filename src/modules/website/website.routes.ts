import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { getOutlets, getConfig, getMenu, getDeals } from './website.controller.js';

export const websiteRouter = Router();

// Deliberately public; outlet comes only from a validated outletId of an ACTIVE outlet.
const readLimiter = rateLimit({
  windowMs: 60_000,
  limit: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: 'Too many requests — please wait a moment and try again.' },
});

websiteRouter.use(readLimiter);

websiteRouter.get('/outlets', getOutlets);
websiteRouter.get('/config', getConfig);
websiteRouter.get('/menu', getMenu);
websiteRouter.get('/deals', getDeals);
