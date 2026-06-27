/**
 * Settings Zod Validation Schemas
 */

import { z } from 'zod';

export const updateSettingsSchema = z.object({
  restaurantName: z.string().max(100).optional(),
  currency: z.string().max(10).optional(),
  taxRate: z.coerce.number().min(0).max(100).optional(),
  taxName: z.string().max(20).optional(),
  phone: z.string().max(20).optional().nullable(),
  email: z.string().email().max(100).optional().nullable(),
  address: z.string().optional().nullable(),
  receiptHeader: z.string().optional().nullable(),
  tableManagement: z.boolean().optional(),
  onlineOrders: z.boolean().optional(),
  reservations: z.boolean().optional(),
  selfOrderConfig: z.record(z.any()).optional(),
  websiteConfig: z.record(z.any()).optional(),
  reservationConfig: z.record(z.any()).optional(),
  shiftConfig: z.record(z.any()).optional(),
});

export type UpdateSettingsInput = z.infer<typeof updateSettingsSchema>;
