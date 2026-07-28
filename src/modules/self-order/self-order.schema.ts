/**
 * Self-Order Zod Validation Schemas
 */

import { z } from 'zod';

export const createSelfOrderSchema = z.object({
  tableId: z.string().uuid('Invalid table'),
  customerName: z.string().trim().min(1, 'Customer name is required').max(100),
  customerPhone: z.string().trim().min(1, 'Phone number is required').max(20),
  guestCount: z.coerce.number().int().min(1, 'Guest count is required').max(50),
  specialInstructions: z.string().max(500).optional(),
  items: z.array(z.object({
    menuItemId: z.string().uuid().optional().nullable(),
    variantId: z.string().uuid().optional().nullable(),
    name: z.string().min(1).max(200),
    qty: z.coerce.number().int().min(1).max(50),
    modifierIds: z.array(z.string().uuid()).optional(),
    notes: z.string().max(500).optional().nullable(),
  })).min(1, 'Order must have at least one item'),
});

export type CreateSelfOrderInput = z.infer<typeof createSelfOrderSchema>;
