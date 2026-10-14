/**
 * Staff side of the website's extra sections: "Coming soon" dishes, dish suggestions and
 * event / catering inquiries. The public side is in website.controller.ts.
 */
import type { Request, Response } from 'express';
import { prisma } from '../../config/database.js';
import { ApiResponse } from '../../utils/ApiResponse.js';
import { ApiError } from '../../utils/ApiError.js';
import { asyncHandler } from '../../utils/asyncHandler.js';
import { resolveOutletScope } from '../../middleware/outletScope.js';

/** GET /api/site-content/coming-soon — every dish, hidden ones last. */
export const listComingSoon = asyncHandler(async (_req: Request, res: Response) => {
  const dishes = await prisma.comingSoonDish.findMany({
    orderBy: [{ isActive: 'desc' }, { votes: 'desc' }, { createdAt: 'asc' }],
  });
  res.json(ApiResponse.success(dishes));
});

export const createComingSoon = asyncHandler(async (req: Request, res: Response) => {
  const { name, description } = req.body as { name: string; description?: string };
  const dish = await prisma.comingSoonDish.create({ data: { name, description: description || null } });
  res.status(201).json(ApiResponse.created(dish, 'Dish added'));
});

export const updateComingSoon = asyncHandler(async (req: Request, res: Response) => {
  const { name, description, isActive } = req.body as { name?: string; description?: string | null; isActive?: boolean };
  const existing = await prisma.comingSoonDish.findUnique({ where: { id: req.params.id } });
  if (!existing) throw ApiError.notFound('Dish not found');
  const dish = await prisma.comingSoonDish.update({
    where: { id: existing.id },
    data: {
      ...(name !== undefined && { name }),
      ...(description !== undefined && { description: description || null }),
      ...(isActive !== undefined && { isActive }),
    },
  });
  res.json(ApiResponse.success(dish, 'Dish updated'));
});

export const deleteComingSoon = asyncHandler(async (req: Request, res: Response) => {
  const deleted = await prisma.comingSoonDish.deleteMany({ where: { id: req.params.id } });
  if (deleted.count === 0) throw ApiError.notFound('Dish not found');
  res.json(ApiResponse.success(null, 'Dish removed'));
});

/** GET /api/site-content/suggestions — the newest 100 "which dish should we start?" answers. */
export const listSuggestions = asyncHandler(async (_req: Request, res: Response) => {
  const suggestions = await prisma.dishSuggestion.findMany({ orderBy: { createdAt: 'desc' }, take: 100 });
  res.json(ApiResponse.success(suggestions));
});

export const deleteSuggestion = asyncHandler(async (req: Request, res: Response) => {
  await prisma.dishSuggestion.deleteMany({ where: { id: req.params.id } });
  res.json(ApiResponse.success(null, 'Suggestion removed'));
});

const toInquiryOut = <T extends { eventDate: Date }>(i: T) => ({ ...i, eventDate: i.eventDate.toISOString().slice(0, 10) });

/** GET /api/site-content/event-inquiries?status= — the branch's newest 200 (Super Admin: every branch). */
export const listEventInquiries = asyncHandler(async (req: Request, res: Response) => {
  const scope = resolveOutletScope(req);
  const status = typeof req.query.status === 'string' && req.query.status ? req.query.status : undefined;
  const inquiries = await prisma.eventInquiry.findMany({
    where: { ...(scope ? { outletId: scope } : {}), ...(status ? { status } : {}) },
    orderBy: { createdAt: 'desc' },
    take: 200,
  });
  const outlets = await prisma.outlet.findMany({
    where: { id: { in: [...new Set(inquiries.map((i) => i.outletId))] } },
    select: { id: true, name: true },
  });
  const names = Object.fromEntries(outlets.map((o) => [o.id, o.name]));
  res.json(ApiResponse.success(inquiries.map((i) => ({ ...toInquiryOut(i), outletName: names[i.outletId] ?? null }))));
});

/** PATCH /api/site-content/event-inquiries/:id { status } — new → contacted → closed. */
export const updateEventInquiry = asyncHandler(async (req: Request, res: Response) => {
  const scope = resolveOutletScope(req);
  const existing = await prisma.eventInquiry.findUnique({ where: { id: req.params.id } });
  if (!existing || (scope && existing.outletId !== scope)) throw ApiError.notFound('Inquiry not found');
  const updated = await prisma.eventInquiry.update({ where: { id: existing.id }, data: { status: req.body.status } });
  res.json(ApiResponse.success(toInquiryOut(updated), 'Inquiry updated'));
});
