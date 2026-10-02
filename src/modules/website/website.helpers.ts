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
  reservationsEnabled: boolean;
}

function parseNumber(value: unknown, defaultValue: number): number {
  if (value == null) return defaultValue;
  const parsed = Number(value);
  if (Number.isNaN(parsed) || parsed < 0) return defaultValue;
  return parsed;
}

function parseNumberNullable(value: unknown, defaultValue: number | null): number | null {
  if (value == null) return defaultValue;
  if (value === '') return defaultValue;
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
    reservationsEnabled: false,
  };

  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return defaults;
  }

  const obj = raw as Record<string, unknown>;
  const enabled = obj.enabled === true || obj.enabled === 'true';
  const reservationsEnabled = obj.reservationsEnabled === true || obj.reservationsEnabled === 'true';

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

  return { enabled, deliveryFee, freeDeliveryAbove, minOrder, prepTimeMinutes, reservationsEnabled };
}

export function isAcceptingOrders(params: { outletActive: boolean; onlineOrders: boolean; config: WebsiteConfig }): boolean {
  return params.outletActive && params.onlineOrders && params.config.enabled;
}

export function computeDeliveryFee(orderType: WebsiteOrderType, config: WebsiteConfig, taxableSubtotal: number): number {
  if (orderType !== 'Delivery') return 0;
  if (config.freeDeliveryAbove !== null && taxableSubtotal >= config.freeDeliveryAbove) return 0;
  return config.deliveryFee;
}

export function normalizePkPhone(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const digits = raw.replace(/\D/g, '');
  let normalized = digits;
  if (digits.length === 12 && digits.startsWith('92')) {
    normalized = '0' + digits.substring(2);
  }
  if (/^03\d{9}$/.test(normalized)) {
    return `${normalized.substring(0, 4)}-${normalized.substring(4)}`;
  }
  return null;
}

export function toWebsiteOrderStatus(order: { status: string; acceptedById?: string | null; type: string }, activeAssignmentStatus: string | null): string {
  switch (order.status) {
    case 'CANCELLED': return 'cancelled';
    case 'PENDING': return order.acceptedById ? 'accepted' : 'pending';
    case 'SCHEDULED': return 'accepted';
    case 'PREPARING': return 'preparing';
    case 'READY': return (order.type === 'DELIVERY' && activeAssignmentStatus === 'dispatched') ? 'out_for_delivery' : 'ready';
    case 'COMPLETED': return 'completed';
    default: return 'pending';
  }
}

export function validateReservationSlot({ date, time, nowMs, maxAdvanceDays = 60 }: { date: string, time: string, nowMs: number, maxAdvanceDays?: number }): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return 'Invalid date format (YYYY-MM-DD)';
  const parsedDate = new Date(date);
  if (Number.isNaN(parsedDate.getTime()) || parsedDate.toISOString().slice(0, 10) !== date) {
    return 'Invalid calendar date';
  }
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) return 'Invalid time format (HH:mm)';
  
  const pkt = new Date(nowMs + 5 * 60 * 60 * 1000);
  const todayStr = pkt.toISOString().slice(0, 10);
  const currentHour = pkt.getUTCHours();
  const currentMinute = pkt.getUTCMinutes();
  const currentTimeStr = `${String(currentHour).padStart(2, '0')}:${String(currentMinute).padStart(2, '0')}`;

  if (date < todayStr) return 'Cannot book in the past';
  if (date === todayStr && time <= currentTimeStr) return 'Cannot book in the past';

  const maxDate = new Date(pkt.getTime() + maxAdvanceDays * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  if (date > maxDate) return `Cannot book more than ${maxAdvanceDays} days in advance`;
  return null;
}

export function toWebsiteReservationStatus(status: string): string {
  switch (status) {
    case 'pending': return 'pending';
    case 'confirmed': return 'confirmed';
    case 'seated': return 'seated';
    case 'completed': return 'completed';
    case 'cancelled': return 'cancelled';
    case 'noShow': return 'no_show';
    default: return 'pending';
  }
}


export function resolveBranchContact(
  outlet: { address?: string | null; phone?: string | null; email?: string | null; city?: string | null },
  settings: { outletId?: string | null; address?: string | null; phone?: string | null; email?: string | null } | null | undefined,
  outletId: string
): { address: string | null; phone: string | null; email: string | null; city: string | null } {
  const isTargetSettings = settings && settings.outletId === outletId;

  const getVal = (setVal?: string | null, outVal?: string | null) => {
    if (isTargetSettings && setVal && setVal.trim() !== '') return setVal.trim();
    if (outVal && outVal.trim() !== '') return outVal.trim();
    return null;
  };

  return {
    address: getVal(settings?.address, outlet?.address),
    phone: getVal(settings?.phone, outlet?.phone),
    email: getVal(settings?.email, outlet?.email),
    city: (outlet?.city && outlet.city.trim() !== '') ? outlet.city.trim() : null,
  };
}
