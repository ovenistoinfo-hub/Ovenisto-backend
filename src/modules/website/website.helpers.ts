export const WEBSITE_ORDER_TYPES = ['Delivery', 'Take Away'] as const;
export type WebsiteOrderType = typeof WEBSITE_ORDER_TYPES[number];

export function parseWebsiteOrderType(value: unknown): WebsiteOrderType | null {
  if (value === 'Delivery' || value === 'Take Away') {
    return value;
  }
  return null;
}

// Reservations (and the menu/deals that feed them) also allow Dine In; /website/quote and
// /website/orders stay Delivery + Take Away (WEBSITE_ORDER_TYPES).
export const WEBSITE_BOOKING_TYPES = ['Dine In', 'Take Away', 'Delivery'] as const;
export type WebsiteBookingType = typeof WEBSITE_BOOKING_TYPES[number];

export function parseWebsiteBookingType(value: unknown): WebsiteBookingType | null {
  if (value === 'Dine In' || value === 'Take Away' || value === 'Delivery') {
    return value;
  }
  return null;
}

export interface DealTaggedLine {
  menuItemId?: string | null;
  variantId?: string | null;
  dealLineId?: string | null;
  dealGroupId?: string | null;
  dealRole?: 'buy' | 'get' | null;
}

/**
 * revalidateDealLines returns deal lines without the client's `dealGroupId`/`dealRole`, but a stored
 * reservation pre-order is revalidated AGAIN by convertReservationToOrder, which needs them (an
 * OPTION_COMBO pick's group, a BUY_X_GET_Y line's side). Copy each priced deal line's tags from the
 * first unused request line with the same dealLineId + menuItemId + variantId.
 */
export function attachDealTags<T extends DealTaggedLine>(
  pricedItems: T[],
  requestItems: DealTaggedLine[],
): Array<T & Pick<DealTaggedLine, 'dealGroupId' | 'dealRole'>> {
  const used = new Set<number>();
  return pricedItems.map((priced) => {
    if (!priced.dealLineId) return priced;
    const idx = requestItems.findIndex((r, i) => !used.has(i)
      && r.dealLineId === priced.dealLineId
      && (r.menuItemId ?? null) === (priced.menuItemId ?? null)
      && (r.variantId ?? null) === (priced.variantId ?? null));
    if (idx === -1) return priced;
    used.add(idx);
    return { ...priced, dealGroupId: requestItems[idx].dealGroupId ?? null, dealRole: requestItems[idx].dealRole ?? null };
  });
}

export interface WebsiteConfig {
  enabled: boolean;
  deliveryFee: number;
  freeDeliveryAbove: number | null;
  minOrder: number;
  prepTimeMinutes: number;
  reservationsEnabled: boolean;
  location: { lat: number; lng: number } | null;
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


export function parseLocation(value: unknown): { lat: number; lng: number } | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const obj = value as Record<string, unknown>;
  if (!('lat' in obj) || !('lng' in obj)) return null;
  
  const lat = Number(obj.lat);
  const lng = Number(obj.lng);
  
  if (Number.isNaN(lat) || !Number.isFinite(lat)) return null;
  if (Number.isNaN(lng) || !Number.isFinite(lng)) return null;
  if (lat === 0 && lng === 0) return null;
  if (lat < -90 || lat > 90) return null;
  if (lng < -180 || lng > 180) return null;
  
  return { lat, lng };
}

export function resolveDeliveryLocation(orderType: WebsiteBookingType, value: unknown): { lat: number; lng: number } | null {
  if (orderType === 'Delivery') {
    return parseLocation(value);
  }
  return null;
}

export function readWebsiteConfig(raw: unknown): WebsiteConfig {
  const defaults: WebsiteConfig = {
    enabled: false,
    deliveryFee: 0,
    freeDeliveryAbove: null,
    minOrder: 0,
    prepTimeMinutes: 30,
    reservationsEnabled: false,
    location: null,
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

  const location = parseLocation(obj.location);

  return { enabled, deliveryFee, freeDeliveryAbove, minOrder, prepTimeMinutes, reservationsEnabled, location };
}

export function isAcceptingOrders(params: { outletActive: boolean; onlineOrders: boolean; config: WebsiteConfig }): boolean {
  return params.outletActive && params.onlineOrders && params.config.enabled;
}

export function computeDeliveryFee(orderType: WebsiteBookingType, config: WebsiteConfig, taxableSubtotal: number): number {
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
