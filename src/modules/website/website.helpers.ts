export const WEBSITE_ORDER_TYPES = ['Delivery', 'Take Away'] as const;
export type WebsiteOrderType = typeof WEBSITE_ORDER_TYPES[number];

export function parseWebsiteOrderType(value: unknown): WebsiteOrderType | null {
  if (value === 'Delivery' || value === 'Take Away') {
    return value;
  }
  return null;
}

export interface WebsiteConfig {
  enabled: boolean;
  deliveryFee: number;
  freeDeliveryAbove: number | null;
  minOrder: number;
  prepTimeMinutes: number;
}

function parseNumber(value: unknown, defaultValue: number): number {
  if (value == null) return defaultValue;
  const parsed = Number(value);
  if (Number.isNaN(parsed) || parsed < 0) return defaultValue;
  return parsed;
}

function parseNumberNullable(value: unknown, defaultValue: number | null): number | null {
  if (value == null) return defaultValue;
  if (value === '') return defaultValue; // Handle empty strings if any
  const parsed = Number(value);
  if (Number.isNaN(parsed) || parsed < 0) return defaultValue;
  return parsed;
}

export function readWebsiteConfig(raw: unknown): WebsiteConfig {
  const defaults: WebsiteConfig = {
    enabled: false,
    deliveryFee: 0,
    freeDeliveryAbove: null,
    minOrder: 0,
    prepTimeMinutes: 30,
  };

  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return defaults;
  }

  const obj = raw as Record<string, unknown>;

  const enabled = obj.enabled === true || obj.enabled === 'true';

  let deliveryFee = defaults.deliveryFee;
  if ('deliveryFee' in obj) {
    deliveryFee = parseNumber(obj.deliveryFee, defaults.deliveryFee);
  } else if ('deliveryCharges' in obj) {
    deliveryFee = parseNumber(obj.deliveryCharges, defaults.deliveryFee);
  }

  const freeDeliveryAbove = parseNumberNullable(obj.freeDeliveryAbove, defaults.freeDeliveryAbove);

  const minOrder = parseNumber(obj.minOrder, defaults.minOrder);

  let prepTimeMinutes = defaults.prepTimeMinutes;
  if ('prepTimeMinutes' in obj) {
    prepTimeMinutes = parseNumber(obj.prepTimeMinutes, defaults.prepTimeMinutes);
  } else if ('prepTime' in obj) {
    prepTimeMinutes = parseNumber(obj.prepTime, defaults.prepTimeMinutes);
  }

  return {
    enabled,
    deliveryFee,
    freeDeliveryAbove,
    minOrder,
    prepTimeMinutes,
  };
}

export function isAcceptingOrders(params: { outletActive: boolean; onlineOrders: boolean; config: WebsiteConfig }): boolean {
  return params.outletActive && params.onlineOrders && params.config.enabled;
}
