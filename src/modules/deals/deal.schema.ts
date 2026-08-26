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

/** One item on one side of a Buy X Get Y offer. Both sides accept several. */
const bogoItemSchema = z.object({
  menuItemId: z.string().uuid(),
  variantId: z.string().uuid().optional().nullable(),
  qty: z.coerce.number().int().min(1).max(50),
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
    type: z.enum(['combo', 'option_combo', 'percentage', 'buy_x_get_y', 'order_discount']),
    // Flat bundle price — only required for combo/option_combo.
    price: z.coerce.number().positive('Deal price must be greater than 0').optional().nullable(),
    dineInPrice: z.coerce.number().min(0).optional().nullable(),
    takeAwayPrice: z.coerce.number().min(0).optional().nullable(),
    deliveryPrice: z.coerce.number().min(0).optional().nullable(),
    foodpandaPrice: z.coerce.number().min(0).optional().nullable(),
    // Per-channel discount-% overrides — percentage deals vary their discount
    // per channel, buy_x_get_y deals vary how much of the free item they cover.
    dineInPercent: z.coerce.number().min(0).max(100).optional().nullable(),
    takeAwayPercent: z.coerce.number().min(0).max(100).optional().nullable(),
    deliveryPercent: z.coerce.number().min(0).max(100).optional().nullable(),
    foodpandaPercent: z.coerce.number().min(0).max(100).optional().nullable(),
    isActive: z.boolean().optional().default(true),
    outletIds: z.array(z.string().uuid()).optional().default([]),
    validFrom: z.coerce.date(),
    validTo: z.coerce.date().optional().nullable(),
    startTime: timeStr.optional().nullable(),
    endTime: timeStr.optional().nullable(),
    // 0 = Sunday … 6 = Saturday. Empty = runs every day.
    activeDays: z.array(z.coerce.number().int().min(0).max(6)).max(7).optional().default([]),
    components: z.array(componentSchema).optional().default([]),
    optionGroups: z.array(optionGroupSchema).optional().default([]),
    // percentage
    discountPercent: z.coerce.number().positive('Discount must be greater than 0').max(100, 'Discount cannot exceed 100%').optional().nullable(),
    applicableItems: z.array(z.string().uuid()).optional().default([]),
    applicableCategories: z.array(z.string().uuid()).optional().default([]),
    // buy_x_get_y — buyItems/getItems are the real shape; the flat buy*/get*
    // fields below are the legacy single-item form, still accepted so an older
    // client keeps working.
    buyItems: z.array(bogoItemSchema).max(20).optional().default([]),
    getItems: z.array(bogoItemSchema).max(20).optional().default([]),
    buyItemId: z.string().uuid().optional().nullable(),
    buyVariantId: z.string().uuid().optional().nullable(),
    buyQty: z.coerce.number().int().min(1).max(50).optional().nullable(),
    getItemId: z.string().uuid().optional().nullable(),
    getVariantId: z.string().uuid().optional().nullable(),
    getQty: z.coerce.number().int().min(1).max(50).optional().nullable(),
    // order_discount
    minSpend: z.coerce.number().min(0).optional().nullable(),
    flatDiscount: z.coerce.number().positive('Discount amount must be greater than 0').optional().nullable(),
  })
  .superRefine((data, ctx) => {
    if (data.validTo && data.validTo < data.validFrom) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'End date cannot be before the start date', path: ['validTo'] });
    }
    if (data.activeDays && new Set(data.activeDays).size !== data.activeDays.length) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'A day cannot be listed twice', path: ['activeDays'] });
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
      // Either shape satisfies each side: the list, or the legacy single item.
      if (data.buyItems.length === 0 && !data.buyItemId) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Add at least one item the customer has to buy', path: ['buyItems'] });
      }
      if (data.getItems.length === 0 && !data.getItemId) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Add at least one item the customer gets free', path: ['getItems'] });
      }
      // Whether a variant is *required* depends on whether the chosen item has
      // any — that needs the menu records, so it is checked in the controller's
      // assertBuyXGetYVariants, not here.
    }

    if (data.type === 'order_discount') {
      const hasFlat = data.flatDiscount != null;
      const hasPercent = data.discountPercent != null;
      if (hasFlat === hasPercent) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Set either a flat Rs. amount or a percentage off — not both', path: ['flatDiscount'] });
      }
      if (data.code) {
        // Promo code: customer enters it, flat amount off only.
        if (hasPercent) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'A promo code can only be a flat Rs. amount off', path: ['discountPercent'] });
        }
      } else {
        // Minimum Spend: auto-applies, needs a threshold to gate on.
        if (data.minSpend == null || data.minSpend <= 0) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Set a minimum spend, or add a code to make this a promo code instead', path: ['minSpend'] });
        }
      }
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
