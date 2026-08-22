/**
 * Deal Zod Validation Schemas
 */

import { z } from 'zod';

const timeStr = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use HH:MM (24-hour)');

const componentSchema = z.object({
  menuItemId: z.string().uuid(),
  variantId: z.string().uuid().optional().nullable(),
  qty: z.coerce.number().int().min(1).max(50),
  displayOrder: z.coerce.number().int().optional(),
});

const optionItemSchema = z.object({
  menuItemId: z.string().uuid(),
  variantId: z.string().uuid().optional().nullable(),
  extraPrice: z.coerce.number().min(0).optional().default(0),
  displayOrder: z.coerce.number().int().optional(),
});

const optionGroupSchema = z
  .object({
    label: z.string().trim().min(1, 'Step label is required').max(100),
    minSelections: z.coerce.number().int().min(1).max(20),
    maxSelections: z.coerce.number().int().min(1).max(20),
    displayOrder: z.coerce.number().int().optional(),
    options: z.array(optionItemSchema).min(1, 'Each step needs at least one selectable item'),
  })
  .superRefine((g, ctx) => {
    if (g.maxSelections < g.minSelections) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Max selections must be at least the minimum', path: ['maxSelections'] });
    }
    if (g.options.length < g.maxSelections) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Not enough items to satisfy the max-selections limit', path: ['options'] });
    }
  });

export const dealSchema = z
  .object({
    name: z.string().trim().min(1, 'Deal name is required').max(100),
    code: z.string().trim().min(1).max(20).optional().nullable(),
    description: z.string().max(1000).optional().nullable(),
    image: z.string().max(2000).optional().nullable(),
    type: z.enum(['combo', 'option_combo', 'percentage', 'buy_x_get_y']),
    // Flat bundle price — only required for combo/option_combo.
    price: z.coerce.number().positive('Deal price must be greater than 0').optional().nullable(),
    dineInPrice: z.coerce.number().min(0).optional().nullable(),
    takeAwayPrice: z.coerce.number().min(0).optional().nullable(),
    deliveryPrice: z.coerce.number().min(0).optional().nullable(),
    foodpandaPrice: z.coerce.number().min(0).optional().nullable(),
    isActive: z.boolean().optional().default(true),
    outletIds: z.array(z.string().uuid()).optional().default([]),
    validFrom: z.coerce.date(),
    validTo: z.coerce.date().optional().nullable(),
    startTime: timeStr.optional().nullable(),
    endTime: timeStr.optional().nullable(),
    components: z.array(componentSchema).optional().default([]),
    optionGroups: z.array(optionGroupSchema).optional().default([]),
    // percentage
    discountPercent: z.coerce.number().positive('Discount must be greater than 0').max(100, 'Discount cannot exceed 100%').optional().nullable(),
    applicableItems: z.array(z.string().uuid()).optional().default([]),
    applicableCategories: z.array(z.string().uuid()).optional().default([]),
    // buy_x_get_y
    buyItemId: z.string().uuid().optional().nullable(),
    buyQty: z.coerce.number().int().min(1).max(50).optional().nullable(),
    getItemId: z.string().uuid().optional().nullable(),
    getQty: z.coerce.number().int().min(1).max(50).optional().nullable(),
  })
  .superRefine((data, ctx) => {
    if (data.validTo && data.validTo < data.validFrom) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'End date cannot be before the start date', path: ['validTo'] });
    }
    if ((data.startTime == null) !== (data.endTime == null)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Set both a start and end time, or neither', path: ['endTime'] });
    }

    if (data.type === 'combo' || data.type === 'option_combo') {
      if (data.price == null) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Deal price is required', path: ['price'] });
      }
      if (data.type === 'combo' && data.components.length === 0) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'A Fixed Bundle needs at least one component item', path: ['components'] });
      }
      if (data.type === 'option_combo' && data.optionGroups.length === 0) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'A Customizable Combo needs at least one step group', path: ['optionGroups'] });
      }
    }

    if (data.type === 'percentage') {
      if (data.discountPercent == null) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Discount percentage is required', path: ['discountPercent'] });
      }
      if (data.applicableItems.length === 0 && data.applicableCategories.length === 0) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Select at least one item or category this discount applies to', path: ['applicableItems'] });
      }
    }

    if (data.type === 'buy_x_get_y') {
      if (!data.buyItemId) ctx.addIssue({ code: z.ZodIssueCode.custom, message: '"Buy" item is required', path: ['buyItemId'] });
      if (!data.buyQty) ctx.addIssue({ code: z.ZodIssueCode.custom, message: '"Buy" quantity is required', path: ['buyQty'] });
      if (!data.getItemId) ctx.addIssue({ code: z.ZodIssueCode.custom, message: '"Get" item is required', path: ['getItemId'] });
      if (!data.getQty) ctx.addIssue({ code: z.ZodIssueCode.custom, message: '"Get" quantity is required', path: ['getQty'] });
    }
  });

export type DealInput = z.infer<typeof dealSchema>;

export const dealSelectionSchema = z.object({
  groupId: z.string().uuid().optional(),
  menuItemId: z.string().uuid(),
  variantId: z.string().uuid().optional().nullable(),
  qty: z.coerce.number().int().min(1).max(50).optional(),
});
export type DealSelectionInput = z.infer<typeof dealSelectionSchema>;
