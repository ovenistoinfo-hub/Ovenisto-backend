import { Router } from 'express';
import { z } from 'zod';
import { authenticate } from '../../middleware/authenticate.js';
import { authorize } from '../../middleware/authorize.js';
import { validateRequest } from '../../middleware/validateRequest.js';
import {
  listComingSoon, createComingSoon, updateComingSoon, deleteComingSoon,
  listSuggestions, deleteSuggestion, listEventInquiries, updateEventInquiry,
  listKitchenPosts, createKitchenPost, updateKitchenPost, deleteKitchenPost,
} from './site-content.controller.js';
import { toVideoEmbedUrl } from './site-content.helpers.js';

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

// Photos come from /api/upload/image; the video is a YouTube or Instagram link the website embeds.
const postImages = z.array(z.string().url().startsWith('https://').max(500)).max(10, 'At most 10 photos');
const postVideo = z.string().trim().max(300)
  .refine((v) => v === '' || toVideoEmbedUrl(v) !== null, 'Paste a YouTube or Instagram link')
  .nullable();
const postCreate = z.object({
  title: z.string().trim().min(2, 'Title is required').max(120),
  body: z.string().trim().max(10000).nullable().optional(),
  images: postImages.optional(),
  videoUrl: postVideo.optional(),
  isPublished: z.boolean().optional(),
});
const postUpdate = postCreate.partial();

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

siteContentRouter.get('/kitchen-posts', authorize(CONTENT_ROLES), listKitchenPosts);
siteContentRouter.post('/kitchen-posts', authorize(CONTENT_ROLES), validateRequest({ body: postCreate }), createKitchenPost);
siteContentRouter.put('/kitchen-posts/:id', authorize(CONTENT_ROLES), validateRequest({ body: postUpdate }), updateKitchenPost);
siteContentRouter.delete('/kitchen-posts/:id', authorize(CONTENT_ROLES), deleteKitchenPost);
