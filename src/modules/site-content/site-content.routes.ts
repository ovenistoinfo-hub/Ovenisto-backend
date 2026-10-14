import { Router } from 'express';
import { z } from 'zod';
import { authenticate } from '../../middleware/authenticate.js';
import { authorize } from '../../middleware/authorize.js';
import { validateRequest } from '../../middleware/validateRequest.js';
import {
  listComingSoon, createComingSoon, updateComingSoon, deleteComingSoon,
  listSuggestions, deleteSuggestion, listEventInquiries, updateEventInquiry,
} from './site-content.controller.js';

// Website content is edited by whoever edits the branch's website settings; event inquiries are
// followed up by the people who handle bookings.
const CONTENT_ROLES = ['Super Admin', 'Admin', 'Manager'];
const INQUIRY_ROLES = ['Super Admin', 'Admin', 'Manager', 'Floor Manager'];

const dishCreate = z.object({
  name: z.string().trim().min(2, 'Name is required').max(100),
  description: z.string().trim().max(200).optional(),
});
const dishUpdate = z.object({
  name: z.string().trim().min(2).max(100).optional(),
  description: z.string().trim().max(200).nullable().optional(),
  isActive: z.boolean().optional(),
});
const inquiryUpdate = z.object({ status: z.enum(['new', 'contacted', 'closed']) });

export const siteContentRouter = Router();

siteContentRouter.use(authenticate);

siteContentRouter.get('/coming-soon', authorize(CONTENT_ROLES), listComingSoon);
siteContentRouter.post('/coming-soon', authorize(CONTENT_ROLES), validateRequest({ body: dishCreate }), createComingSoon);
siteContentRouter.put('/coming-soon/:id', authorize(CONTENT_ROLES), validateRequest({ body: dishUpdate }), updateComingSoon);
siteContentRouter.delete('/coming-soon/:id', authorize(CONTENT_ROLES), deleteComingSoon);

siteContentRouter.get('/suggestions', authorize(CONTENT_ROLES), listSuggestions);
siteContentRouter.delete('/suggestions/:id', authorize(CONTENT_ROLES), deleteSuggestion);

siteContentRouter.get('/event-inquiries', authorize(INQUIRY_ROLES), listEventInquiries);
siteContentRouter.patch('/event-inquiries/:id', authorize(INQUIRY_ROLES), validateRequest({ body: inquiryUpdate }), updateEventInquiry);
