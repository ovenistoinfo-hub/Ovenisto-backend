import { z } from 'zod';
import { WEBSITE_ORDER_TYPES, WEBSITE_BOOKING_TYPES } from './website.helpers.js';

export const itemSchema = z.object({
  menuItemId: z.string().uuid().optional().nullable(),
  variantId: z.string().uuid().optional().nullable(),
  name: z.string().min(1).max(200),
  qty: z.number().int().min(1).max(50),
  modifierIds: z.array(z.string().uuid()).optional(),
  notes: z.string().max(500).optional().nullable(),
  dealId: z.string().uuid().optional().nullable(),
  dealLineId: z.string().optional().nullable(),
  dealGroupId: z.string().uuid().optional().nullable(),
  dealRole: z.enum(['buy', 'get']).optional().nullable(),
});

export const quoteCartSchema = z.object({
  outletId: z.string().uuid('Invalid outletId'),
  orderType: z.enum(WEBSITE_ORDER_TYPES, { errorMap: () => ({ message: 'type must be Delivery or Take Away' }) }),
  items: z.array(itemSchema).min(1).max(50, 'Cart cannot have more than 50 distinct items'),
  dealCode: z.string().trim().max(20).optional().nullable(),
});

export const createOrderSchema = quoteCartSchema.extend({
  customerName: z.string().trim().min(1, 'Name is required').max(100),
  customerPhone: z.string().trim().max(20, 'Phone is too long'),
  deliveryAddress: z.string().trim().max(300).optional(),
  deliveryLocation: z.object({ lat: z.number(), lng: z.number() }).optional(),
  specialInstructions: z.string().max(500).optional(),
  clientRequestId: z.string().max(64).optional(),
}).superRefine((data, ctx) => {
  if (data.orderType === 'Delivery') {
    if (!data.deliveryAddress || data.deliveryAddress.length < 10) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Delivery address is required and must be at least 10 characters',
        path: ['deliveryAddress'],
      });
    }
  }
});

const bookingTypeSchema = z.enum(WEBSITE_BOOKING_TYPES, { errorMap: () => ({ message: 'type must be Dine In, Take Away or Delivery' }) });

// A Take Away / Delivery booking is a future order, so it needs food; Dine In may pre-order or not.
function requireItemsUnlessDineIn(data: { orderType: string; items: unknown[] }, ctx: z.RefinementCtx) {
  if (data.orderType !== 'Dine In' && data.items.length === 0) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Add at least one item to pre-order', path: ['items'] });
  }
}

export const reservationSchema = z.object({
  outletId: z.string().uuid('Invalid outletId'),
  customerName: z.string().trim().min(1, 'Name is required').max(100),
  customerPhone: z.string().trim().max(20, 'Phone is too long'),
  date: z.string().trim().min(1, 'Date is required'),
  time: z.string().trim().min(1, 'Time is required'),
  guestCount: z.number().int().min(1).max(20).optional().default(1),
  specialRequests: z.string().trim().max(500).optional(),
  orderType: bookingTypeSchema.optional().default('Dine In'),
  items: z.array(itemSchema).max(50, 'Cart cannot have more than 50 distinct items').optional().default([]),
  deliveryAddress: z.string().trim().max(300).optional(),
  deliveryLocation: z.object({ lat: z.number(), lng: z.number() }).optional(),
}).superRefine((data, ctx) => {
  requireItemsUnlessDineIn(data, ctx);
  if (data.orderType === 'Delivery' && (!data.deliveryAddress || data.deliveryAddress.length < 10)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Delivery address is required and must be at least 10 characters',
      path: ['deliveryAddress'],
    });
  }
});

export const quoteReservationSchema = z.object({
  outletId: z.string().uuid('Invalid outletId'),
  orderType: bookingTypeSchema,
  items: z.array(itemSchema).max(50, 'Cart cannot have more than 50 distinct items').optional().default([]),
}).superRefine(requireItemsUnlessDineIn);
