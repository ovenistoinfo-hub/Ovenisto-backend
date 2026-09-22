/**
 * Delivery Helpers
 * Pure logic helpers for rider delivery metrics, date ranges, and earnings breakdowns.
 */
import {
  getCashierPaymentMethodString,
  getRiderPaymentMethodString,
} from '../cash-settlement/cash-settlement.service.js';

export interface DayEarnings {
  date: string; // YYYY-MM-DD (PKT)
  orders: number;
  sales: number;
  commissions: number;
}

export interface EarningsBreakdownResult {
  totalOrders: number;
  totalSales: number;
  totalCommissions: number;
  breakdown: DayEarnings[];
}

/**
 * Returns current PKT week range (Monday through today).
 * Mirrors CLAUDE.md's "PKT Timezone Pattern".
 */
export function getDefaultWeekRange(nowMs: number = Date.now()): { from: string; to: string } {
  const pktNowMs = nowMs + 5 * 60 * 60 * 1000;
  const pkt = new Date(pktNowMs);
  const day = pkt.getUTCDay(); // 0=Sun
  const monMs = pktNowMs + (day === 0 ? -6 : 1 - day) * 86_400_000;
  return {
    from: new Date(monMs).toISOString().split('T')[0],
    to: pkt.toISOString().split('T')[0],
  };
}

/**
 * Group delivered assignments by PKT calendar day across [from, to] inclusive.
 * Fills missing days with 0 counts.
 */
export function groupDeliveriesByDay(
  assignments: Array<{
    deliveredAt: Date | null;
    commissionEarned?: number | { toNumber?(): number; toString(): string } | null;
    order?: { total?: number | { toNumber?(): number; toString(): string } | null } | null;
  }>,
  from: string,
  to: string
): EarningsBreakdownResult {
  const dayMap = new Map<string, { orders: number; sales: number; commissions: number }>();
  let totalOrders = 0;
  let totalSales = 0;
  let totalCommissions = 0;

  for (const a of assignments) {
    if (!a.deliveredAt) continue;
    // Shift UTC timestamp by +5h to determine PKT calendar day
    const pktDate = new Date(a.deliveredAt.getTime() + 5 * 60 * 60 * 1000).toISOString().split('T')[0];
    const sales = Number(a.order?.total ?? 0);
    const commissions = Number(a.commissionEarned ?? 0);

    totalOrders += 1;
    totalSales += sales;
    totalCommissions += commissions;

    const cur = dayMap.get(pktDate) ?? { orders: 0, sales: 0, commissions: 0 };
    cur.orders += 1;
    cur.sales += sales;
    cur.commissions += commissions;
    dayMap.set(pktDate, cur);
  }

  const breakdown: DayEarnings[] = [];
  const cursor = new Date(`${from}T00:00:00.000Z`);
  const end = new Date(`${to}T00:00:00.000Z`);
  while (cursor.getTime() <= end.getTime()) {
    const key = cursor.toISOString().slice(0, 10);
    const d = dayMap.get(key) ?? { orders: 0, sales: 0, commissions: 0 };
    breakdown.push({
      date: key,
      orders: d.orders,
      sales: d.sales,
      commissions: d.commissions,
    });
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }

  return {
    totalOrders,
    totalSales,
    totalCommissions,
    breakdown,
  };
}

export interface RankedRiderRow {
  riderId: string;
  name: string;
  deliveries: number;
  commissionEarned?: number;
}

export interface RankedRiderResult {
  riderId: string;
  name: string;
  deliveries: number;
  rank: number;
  isMe: boolean;
  commissionEarned?: number;
}

/**
 * Rank riders by deliveries desc, then name asc, with competition ranking (1224) for ties.
 * commissionEarned is included only for caller's own row (isMe) or when includeAllCommission is true.
 */
export function rankRiders(
  rows: RankedRiderRow[],
  callerRiderId?: string | null,
  includeAllCommission: boolean = false
): RankedRiderResult[] {
  const sorted = [...rows].sort(
    (a, b) => b.deliveries - a.deliveries || a.name.localeCompare(b.name)
  );

  let currentRank = 1;
  const result: RankedRiderResult[] = [];

  for (let i = 0; i < sorted.length; i++) {
    const row = sorted[i];
    if (i > 0) {
      if (row.deliveries < sorted[i - 1].deliveries) {
        currentRank = i + 1;
      }
    }

    const isMe = Boolean(callerRiderId && row.riderId === callerRiderId);
    const item: RankedRiderResult = {
      riderId: row.riderId,
      name: row.name,
      deliveries: row.deliveries,
      rank: currentRank,
      isMe,
    };

    if (includeAllCommission || isMe) {
      item.commissionEarned = Number(row.commissionEarned ?? 0);
    }

    result.push(item);
  }

  return result;
}

/**
 * Derive clean payment label for delivery history rows.
 */
export function deriveHistoryPaymentLabel(
  status: string,
  paymentMethod?: string | null
): string | null {
  if (status === 'returned') return null;
  if (!paymentMethod || !paymentMethod.trim()) return null;

  const pm = paymentMethod.trim();
  const pmLower = pm.toLowerCase();
  if (pmLower === 'pending' || pmLower === 'unpaid') return null;

  const hasCODBalance = /cod balance\s*\(/i.test(pm);
  const hasAdvance = /advance\s*\(/i.test(pm);

  if (hasCODBalance) {
    return getRiderPaymentMethodString(pm);
  }

  if (hasAdvance) {
    return getCashierPaymentMethodString(pm);
  }

  // Split payment string without COD/Advance wrappers, e.g. "Cash: Rs.900, JazzCash: Rs.779"
  if (pm.includes(':') || pm.includes(',')) {
    const parts = pm.split(',');
    const methods: string[] = [];
    for (const part of parts) {
      const subParts = part.split(':');
      let methodLabel = subParts[0].trim();
      const parenMatch = methodLabel.match(/\(([^)]+)\)/);
      if (parenMatch) {
        methodLabel = parenMatch[1].trim();
      }
      if (methodLabel && !methods.includes(methodLabel)) {
        methods.push(methodLabel);
      }
    }
    if (methods.length > 0) {
      return methods.join(' + ');
    }
  }

  // Plain method ("Card", "Credit Card") -> unchanged
  return pm;
}
