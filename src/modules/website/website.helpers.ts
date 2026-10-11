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

/** A pre-order line as the website sends it, or as a reservation stores it (`preOrderItems`). */
export interface PreOrderLineLike {
  menuItemId?: string | null;
  variantId?: string | null;
  qty?: number | string | null;
  dealId?: string | null;
  // The website sends modifier ids; a stored line holds [{ modifierId, qty }].
  modifierIds?: unknown;
}

function modifierKey(raw: unknown): string {
  if (!Array.isArray(raw)) return '';
  return raw
    .map((m) => (typeof m === 'string' ? m : (m && typeof m === 'object' && 'modifierId' in m ? String(m.modifierId) : '')))
    .filter(Boolean)
    .sort()
    .join(',');
}

/**
 * Order-independent fingerprint of a pre-order: item, size, qty, modifiers and deal per line. Prices
 * are left out (the server re-prices) and so is the client-made dealLineId. Two bookings with the same
 * signature are the same booking submitted twice.
 */
export function preOrderSignature(lines: PreOrderLineLike[] | null | undefined): string {
  return (lines ?? [])
    .map((l) => [l.menuItemId ?? '', l.variantId ?? '', Number(l.qty ?? 0), modifierKey(l.modifierIds), l.dealId ?? ''].join('|'))
    .sort()
    .join(';');
}

export interface WebsiteConfig {
  enabled: boolean;
  deliveryFee: number;
  freeDeliveryAbove: number | null;
  minOrder: number;
  prepTimeMinutes: number;
  reservationsEnabled: boolean;
  location: { lat: number; lng: number } | null;
  /** Opening hours, 24h "HH:mm" PKT. A `close` at or before `open` means it closes after midnight. */
  hours: { open: string; close: string } | null;
  /** Serving times per MealType id (same shape as `hours`). A meal type without an entry is served all day. */
  mealHours: Record<string, { open: string; close: string }>;
}

const HH_MM = /^([01]\d|2[0-3]):[0-5]\d$/;

/** `{ open, close }` as two valid, different "HH:mm" times, else null (not set). */
export function parseHours(value: unknown): { open: string; close: string } | null {
  if (!value || typeof value !== 'object') return null;
  const { open, close } = value as Record<string, unknown>;
  if (typeof open !== 'string' || typeof close !== 'string' || !HH_MM.test(open) || !HH_MM.test(close) || open === close) return null;
  return { open, close };
}

/** `{ [mealTypeId]: { open, close } }`, keeping only valid entries. */
export function parseMealHours(value: unknown): Record<string, { open: string; close: string }> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const out: Record<string, { open: string; close: string }> = {};
  for (const [id, h] of Object.entries(value)) {
    const parsed = parseHours(h);
    if (parsed) out[id] = parsed;
  }
  return out;
}

/** "08:30" → 510. */
export const toMinutes = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));

/** Minutes after midnight in PKT (UTC+5, no DST). */
export const pktMinuteNow = (nowMs = Date.now()) => {
  const pkt = new Date(nowMs + 5 * 60 * 60 * 1000);
  return pkt.getUTCHours() * 60 + pkt.getUTCMinutes();
};

/** Whether `minute` (minutes after midnight, PKT) is inside [open, close); a window past midnight wraps. */
export function inHoursWindow(hours: { open: string; close: string }, minute: number): boolean {
  const open = toMinutes(hours.open);
  const close = toMinutes(hours.close);
  return open < close ? minute >= open && minute < close : minute >= open || minute < close;
}

/**
 * Whether a dish tagged with `mealTypeIds` is served at `minute`. Untagged dishes, and dishes with any meal
 * type that has no serving time (e.g. All-Day Dining left blank), are always served; otherwise the minute
 * must fall inside one of its meal types' windows. `mealHours` should hold active meal types only.
 */
export function isServedAt(mealTypeIds: string[], mealHours: Record<string, { open: string; close: string }>, minute: number): boolean {
  if (mealTypeIds.length === 0 || mealTypeIds.some((id) => !mealHours[id])) return true;
  return mealTypeIds.some((id) => inHoursWindow(mealHours[id], minute));
}

/** A branch's timed meals for display ("Breakfast 08:00–11:00"…), in serving order; untimed meals are left out. */
export function listMealTimes(
  mealTypes: { id: string; name: string }[],
  mealHours: Record<string, { open: string; close: string }>,
): { name: string; open: string; close: string }[] {
  return mealTypes
    .filter((m) => mealHours[m.id])
    .map((m) => ({ name: m.name, ...mealHours[m.id] }))
    .sort((a, b) => a.open.localeCompare(b.open));
}

/** "19:30" → "7:30 PM". */
export function format12h(time: string): string {
  const h = Number(time.slice(0, 2));
  return `${h % 12 || 12}:${time.slice(3, 5)} ${h >= 12 ? 'PM' : 'AM'}`;
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
    hours: null,
    mealHours: {},
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
  const hours = parseHours(obj.hours);
  const mealHours = parseMealHours(obj.mealHours);

  return { enabled, deliveryFee, freeDeliveryAbove, minOrder, prepTimeMinutes, reservationsEnabled, location, hours, mealHours };
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

/**
 * True for an email + password account whose address isn't verified yet (Firebase ID token claims).
 * Google and phone sign-ins prove the account themselves, so only the password provider is checked.
 */
export function isUnverifiedEmailAccount(claims: { email_verified?: boolean; firebase?: { sign_in_provider?: string } }): boolean {
  return claims.firebase?.sign_in_provider === 'password' && claims.email_verified !== true;
}

/** The token from an `Authorization: Bearer <token>` header, or null when there is none. */
export function parseBearerToken(header: string | undefined): string | null {
  const match = /^Bearer\s+(\S+)\s*$/i.exec(header ?? '');
  return match ? match[1] : null;
}
