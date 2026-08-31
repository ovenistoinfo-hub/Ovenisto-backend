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
    type: z.enum(['combo', 'option_combo', 'percentage', 'buy_x_get_y', 'promo_code', 'min_spend']),
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
    // Channel-availability gates — every deal type, not just the ones with
    // channel price/percent overrides above.
    availableDineIn: z.boolean().optional().default(true),
    availableTakeaway: z.boolean().optional().default(true),
    availableDelivery: z.boolean().optional().default(true),
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
    // buy_x_get_y — each side is independently "fixed" (buyItems/getItems, the
    // flat all-required list — the only shape before this feature) or
    // "customizable" (buyGroups/getGroups, an option set the customer chooses
    // from, same shape option_combo's optionGroups uses). The flat buy*/get*
    // fields below are the legacy single-item form, still accepted so an
    // older client keeps working when buyMode/getMode is "fixed".
    buyMode: z.enum(['fixed', 'customizable']).optional().default('fixed'),
    getMode: z.enum(['fixed', 'customizable']).optional().default('fixed'),
    buyItems: z.array(bogoItemSchema).max(20).optional().default([]),
    getItems: z.array(bogoItemSchema).max(20).optional().default([]),
    buyGroups: z.array(optionGroupSchema).max(10).optional().default([]),
    getGroups: z.array(optionGroupSchema).max(10).optional().default([]),
    buyItemId: z.string().uuid().optional().nullable(),
    buyVariantId: z.string().uuid().optional().nullable(),
    buyQty: z.coerce.number().int().min(1).max(50).optional().nullable(),
    getItemId: z.string().uuid().optional().nullable(),
    getVariantId: z.string().uuid().optional().nullable(),
    getQty: z.coerce.number().int().min(1).max(50).optional().nullable(),
    // promo_code / min_spend
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
      // Buy side: fixed mode needs the item list (or the legacy single item);
      // customizable mode needs at least one option group.
      if (data.buyMode === 'customizable') {
        if (data.buyGroups.length === 0) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Add at least one option group for what the customer can buy', path: ['buyGroups'] });
        }
      } else if (data.buyItems.length === 0 && !data.buyItemId) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Add at least one item the customer has to buy', path: ['buyItems'] });
      }
      // Get side: same split.
      if (data.getMode === 'customizable') {
        if (data.getGroups.length === 0) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Add at least one option group for what the customer gets free', path: ['getGroups'] });
        }
      } else if (data.getItems.length === 0 && !data.getItemId) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Add at least one item the customer gets free', path: ['getItems'] });
      }
      // Whether a variant is *required* depends on whether the chosen item has
      // any — that needs the menu records, so it is checked in the controller's
      // assertBuyXGetYVariants, not here.
    }

    if (data.type === 'promo_code' || data.type === 'min_spend') {
      const hasFlat = data.flatDiscount != null;
      const hasPercent = data.discountPercent != null;
      if (hasFlat === hasPercent) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Set either a flat Rs. amount or a percentage off — not both', path: ['flatDiscount'] });
      }
      if (data.type === 'promo_code' && !data.code) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'A Promo Code deal needs a code', path: ['code'] });
      }
      if (data.type === 'min_spend' && (data.minSpend == null || data.minSpend <= 0)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Set a minimum spend for this deal to auto-apply at', path: ['minSpend'] });
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
