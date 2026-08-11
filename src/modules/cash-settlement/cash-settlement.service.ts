import { Prisma } from '@prisma/client';
import { prisma } from '../../config/database.js';
import { ApiError } from '../../utils/ApiError.js';
import { emitToOutlets } from '../../socket.js';

// Tag on each order in a staff balance identifying where the sale came from —
// shown in Cash Hub, and used by createSettlement to route each order to its
// correct settlement field per-order rather than guessing once for the whole batch.
const RIDER_CHANNEL = 'Delivery Rider (COD)';

export function getCashierPaymentMethodString(pmString: string | null | undefined): string {
  if (!pmString) return 'Cash';
  // Extract just the method name from "Advance (JazzCash): Rs.507" → "JazzCash"
  // Stops at ) or : or , to avoid including embedded amounts
  const match = pmString.match(/Advance\s*\(([^):,]+)/i);
  if (match) {
    return match[1].trim();
  }
  if (pmString.toLowerCase().includes('cash on delivery')) {
    return 'Cash';
  }
  return pmString;
}

export function getRiderPaymentMethodString(pmString: string | null | undefined): string {
  if (!pmString) return 'Cash';
  // Extract just the method name from "COD Balance (Cash): Rs.1000" → "Cash"
  const match = pmString.match(/COD Balance\s*\(([^):,]+)/i);
  if (match) {
    return match[1].trim();
  }
  return pmString;
}

export function parsePaymentMethodAmounts(
  pmString: string | null | undefined,
  totalAmount: number,
  configuredMethods: string[]
): Record<string, number> {
  const result: Record<string, number> = {};
  for (const m of configuredMethods) {
    result[m] = 0;
  }

  if (!pmString || !pmString.trim()) {
    const cashKey = configuredMethods.find((m) => m.toLowerCase() === 'cash') || configuredMethods[0] || 'Cash';
    result[cashKey] = totalAmount;
    return result;
  }

  const raw = pmString.trim();
  const lowerRaw = raw.toLowerCase();

  // If order payment status is Pending or Unpaid, no money was collected yet
  if (lowerRaw === 'pending' || lowerRaw === 'unpaid') {
    return result;
  }

  // 1. Exact case-insensitive match against configured methods (single method)
  const exactMatch = configuredMethods.find((m) => m.toLowerCase() === lowerRaw);
  if (exactMatch) {
    result[exactMatch] = totalAmount;
    return result;
  }

  // 2. Split payment string parsing (e.g. "Cash: Rs.1000, EasyPaisa: Rs.333" or "Advance (Cash: Rs.500), COD Balance (JazzCash): Rs.1000")
  if (raw.includes(':') || raw.includes(',')) {
    const parts = raw.split(',');
    let parsedSum = 0;
    for (const part of parts) {
      let methodLabel = '';
      let valueStr = '';

      const advanceMatch = part.match(/Advance\s*\(([^)]+)\)/i);
      const codMatch = part.match(/COD Balance\s*\(([^)]+)\)/i);

      if (advanceMatch) {
        const inner = advanceMatch[1];
        if (inner.includes(':')) {
          const [m, v] = inner.split(':');
          methodLabel = m.trim();
          valueStr = v;
        } else {
          methodLabel = inner.trim();
          const colIdx = part.lastIndexOf(':');
          if (colIdx !== -1) valueStr = part.substring(colIdx + 1);
        }
      } else if (codMatch) {
        const inner = codMatch[1];
        if (inner.includes(':')) {
          const [m, v] = inner.split(':');
          methodLabel = m.trim();
          valueStr = v;
        } else {
          methodLabel = inner.trim();
          const colIdx = part.lastIndexOf(':');
          if (colIdx !== -1) valueStr = part.substring(colIdx + 1);
        }
      } else {
        const subParts = part.split(':');
        if (subParts.length >= 2) {
          methodLabel = subParts[0].trim();
          const parenMatch = methodLabel.match(/\(([^)]+)\)/);
          if (parenMatch) {
            methodLabel = parenMatch[1].trim();
          }
          valueStr = subParts[subParts.length - 1];
        }
      }

      if (methodLabel && valueStr) {
        const cleanedValueStr = valueStr.replace(/Rs\.?|PKR/gi, '').trim();
        const val = parseFloat(cleanedValueStr);
        if (!isNaN(val) && val > 0) {
          const lml = methodLabel.toLowerCase();
          const matchedMethod =
            configuredMethods.find((m) => m.toLowerCase() === lml) ||
            configuredMethods.find((m) => {
              const lm = m.toLowerCase();
              if (lm === 'cash' && (lml === 'cash' || lml.includes('cash'))) return true;
              if (lm.includes('card') && (lml.includes('card') || lml.includes('credit'))) return true;
              if (lm.includes('jazz') && lml.includes('jazz')) return true;
              if (lm.includes('easy') && lml.includes('easy')) return true;
              return false;
            }) ||
            methodLabel;

          result[matchedMethod] = (result[matchedMethod] || 0) + val;
          parsedSum += val;
        }
      }
    }
    if (parsedSum > 0) {
      return result;
    }
  }

  // 3. Direct single-method alias mapping (e.g., "card" -> "Credit Card", "cash" -> "Cash")
  for (const m of configuredMethods) {
    const lowerM = m.toLowerCase();
    if (
      lowerM === lowerRaw ||
      (lowerM.includes('card') && (lowerRaw === 'card' || lowerRaw === 'credit card' || lowerRaw === 'bank')) ||
      (lowerM === 'cash' && lowerRaw === 'cash') ||
      (lowerM.includes('jazz') && lowerRaw === 'jazzcash') ||
      (lowerM.includes('easy') && lowerRaw === 'easypaisa')
    ) {
      result[m] = totalAmount;
      return result;
    }
  }

  // 4. Substring match for single method
  for (const m of configuredMethods) {
    const lowerM = m.toLowerCase();
    if (lowerRaw === lowerM || (lowerM === 'cash' && lowerRaw.includes('cash') && !lowerRaw.includes('jazz') && !lowerRaw.includes('easy'))) {
      result[m] = totalAmount;
      return result;
    }
  }

  // Fallback: assign to raw string
  result[raw] = totalAmount;
  return result;
}

export function mapOrder(o: any) {
  return {
    id: o.id,
    orderNumber: o.orderNumber,
    customerName: o.customerName || o.customer?.name || "Walk-in",
    total: Number(o.total),
    subtotal: Number(o.subtotal ?? 0),
    tax: Number(o.tax ?? 0),
    discount: Number(o.discount ?? 0),
    paymentMethod: o.paymentMethod,
    status: o.status,
    type: o.type,
    createdAt: o.createdAt,
    outletId: o.outletId,
    staffId: o.staffId,
    riderId: o.riderId,
  };
}

export function mapSettlement(s: any) {
  return {
    id: s.id,
    settlementNo: s.settlementNo,
    outletId: s.outletId,
    staffId: s.staffId,
    staffName: s.staffName,
    staffRole: s.staffRole,
    settledById: s.settledById,
    settledByName: s.settledByName,
    expectedCash: Number(s.expectedCash),
    expectedCard: Number(s.expectedCard),
    expectedOnline: Number(s.expectedOnline),
    totalExpected: Number(s.totalExpected),
    actualCash: Number(s.actualCash),
    actualCard: Number(s.actualCard),
    actualOnline: Number(s.actualOnline),
    totalActual: Number(s.totalActual),
    cashDifference: Number(s.cashDifference),
    paymentBreakdown: s.paymentBreakdown ?? null,
    notes: s.notes ?? null,
    createdAt: s.createdAt,
    orderCount: s.orders ? s.orders.length : undefined,
    orders: s.orders ? s.orders.map(mapOrder) : undefined,
    staff: s.staff ? { id: s.staff.id, name: s.staff.name, role: s.staff.role } : undefined,
    settledBy: s.settledBy ? { id: s.settledBy.id, name: s.settledBy.name, role: s.settledBy.role } : undefined,
  };
}

export async function getActiveBalances(outletScope: string | null) {
  let configuredMethods = ['Cash', 'Credit Card', 'Account', 'JazzCash', 'EasyPaisa'];
  try {
    const settingsWhere: Prisma.SettingsWhereInput = outletScope ? { outletId: outletScope } : {};
    const settings = await prisma.settings.findFirst({ where: settingsWhere });
    if (settings && Array.isArray(settings.paymentMethods) && settings.paymentMethods.length > 0) {
      configuredMethods = settings.paymentMethods;
    }
  } catch {}

  const where: Prisma.OrderWhereInput = {
    // Not legacy-settled (covers regular orders settled before this split-settlement feature)
    settlementId: null,
    status: { not: 'CANCELLED' },
    AND: [
      {
        paymentMethod: {
          notIn: ['Pending', 'Unpaid', 'pending', 'unpaid', 'PENDING', 'UNPAID'],
        },
      },
      {
        paymentMethod: {
          not: null,
        },
      },
      {
        // Include only orders where at least one portion is still unsettled.
        // For split advance/COD orders: cashier and rider each have their own ID.
        // For regular orders: both are null, so OR is trivially true.
        OR: [
          { cashierSettlementId: null },
          { riderSettlementId: null },
        ],
      },
    ],
  };

  if (outletScope) {
    where.outletId = outletScope;
  }

  const orders = await prisma.order.findMany({
    where,
    include: {
      rider: {
        include: {
          user: true,
        },
      },
      staff: true,
    },
    orderBy: { createdAt: 'desc' },
  });

  const staffMap = new Map<
    string,
    {
      staffId: string;
      staffName: string;
      staffRole: string;
      accountLinked: boolean;
      oldestOrderAt: Date;
      expectedCash: number;
      expectedCard: number;
      expectedOnline: number;
      byMethod: Record<string, number>;
      orders: any[];
    }
  >();

  const allocateToStaffGroup = (
    staffId: string,
    staffName: string,
    staffRole: string,
    accountLinked: boolean,
    pmString: string,
    amount: number,
    orderObj: any,
    channel: string
  ) => {
    if (amount <= 0) return;

    if (!staffMap.has(staffId)) {
      const initialByMethod: Record<string, number> = {};
      for (const m of configuredMethods) {
        initialByMethod[m] = 0;
      }
      staffMap.set(staffId, {
        staffId,
        staffName,
        staffRole,
        accountLinked,
        oldestOrderAt: orderObj.createdAt,
        expectedCash: 0,
        expectedCard: 0,
        expectedOnline: 0,
        byMethod: initialByMethod,
        orders: [],
      });
    }

    const group = staffMap.get(staffId)!;
    if (orderObj.createdAt < group.oldestOrderAt) group.oldestOrderAt = orderObj.createdAt;
    const parsedAmounts = parsePaymentMethodAmounts(pmString, amount, configuredMethods);

    let hasNonZero = false;
    for (const [method, parsedAmt] of Object.entries(parsedAmounts)) {
      if (parsedAmt > 0) hasNonZero = true;
      group.byMethod[method] = Number(((group.byMethod[method] || 0) + parsedAmt).toFixed(2));

      const lowerM = method.toLowerCase().trim();
      const isCash = lowerM === 'cash';
      // Bank belongs under "Online" per the cash-hub design spec — only genuine
      // card-network methods (Credit/Debit Card) count as "Card" here.
      const isCard = lowerM.includes('card');

      if (isCash) {
        group.expectedCash += parsedAmt;
      } else if (isCard) {
        group.expectedCard += parsedAmt;
      } else {
        group.expectedOnline += parsedAmt;
      }
    }

    if (hasNonZero) {
      if (!group.orders.some((o: any) => o.id === orderObj.id)) {
        // staffAmount = what this staff member is responsible for from this order
        // (e.g. advance amount for cashier, remaining COD for rider — not the full order total)
        // channel = where this sale came from (POS / Waiter Panel / Delivery Rider COD) —
        // shown in Cash Hub so a mixed-role login's sales stay distinguishable, and used
        // by createSettlement to route each order to its correct settlement field
        // per-order instead of guessing once for the whole batch.
        group.orders.push({ ...mapOrder(orderObj), staffAmount: amount, channel });
      }
    }
  };

  const getCashierChannel = (orderObj: any): string => {
    const src = (orderObj.orderSource || '').toLowerCase();
    if (src === 'waiter' || src === 'table') return 'Waiter Panel';
    if (src === 'self-order') return 'Self-Order (QR)';
    return 'POS Counter';
  };

  for (const order of orders) {
    const orderTotal = Number(order.total || 0);
    const pm = order.paymentMethod || '';
    const pmLower = pm.toLowerCase().trim();
    const hasAdvanceInPM  = /advance\s*\(/i.test(pm);
    const hasCODBalanceInPM = /cod balance\s*\(/i.test(pm);
    const advanceAmount = Number(order.advancePayment || 0);

    const isCODPM = pmLower === 'cash on delivery' || pmLower === 'cod' || pmLower === 'cash-on-delivery' || hasCODBalanceInPM;
    // isPrepaid: advance covers entire order (advance >= total AND advance > 0), OR
    // paymentMethod is a direct paid string (e.g. "Cash", "JazzCash", "Credit Card", "Cash: Rs.1500") and NOT COD and NOT Advance.
    const isPrepaid = (advanceAmount > 0 && advanceAmount >= orderTotal) || (!isCODPM && !hasAdvanceInPM && pmLower !== 'pending' && pmLower !== 'unpaid' && pmLower !== '');

    // Pure COD orders not yet delivered: paymentMethod is still "Cash on Delivery" (or similar).
    // No money has been collected by anyone — skip this order entirely.
    if (!isPrepaid && !hasAdvanceInPM && (
      pmLower === 'cash on delivery' ||
      pmLower === 'cod' ||
      pmLower === 'cash-on-delivery' ||
      pmLower === 'pending' ||
      pmLower === 'unpaid'
    )) {
      continue;
    }

    let cashierAmount = 0;
    let cashierPm = '';
    let riderAmount = 0;
    let riderPm = '';

    if (isPrepaid) {
      // Full prepaid (Dine In, Takeaway, or Delivery Prepaid) — POS cashier/online collected full bill
      cashierAmount = orderTotal;
      cashierPm = pm;
    } else if (hasAdvanceInPM && hasCODBalanceInPM) {
      // Rider has delivered and updated payment method for split advance order:
      // "Advance (JazzCash: Rs.507), COD Balance (Cash): Rs.1000"
      // Cashier keeps the advance, rider gets the remaining COD
      cashierAmount = advanceAmount;
      cashierPm = getCashierPaymentMethodString(pm);  // → "JazzCash"
      riderAmount = Math.max(0, orderTotal - advanceAmount);
      riderPm = getRiderPaymentMethodString(pm);      // → "Cash"
    } else if (hasAdvanceInPM) {
      // Advance collected by cashier, but rider has NOT delivered yet (no COD Balance).
      // Only credit cashier with the advance; rider's COD is still outstanding.
      cashierAmount = advanceAmount;
      cashierPm = getCashierPaymentMethodString(pm);  // → "JazzCash"
      // riderAmount stays 0 until delivered
    } else if (hasCODBalanceInPM || ((order.riderId || (order.type as any) === 'Delivery' || (order.type as any) === 'DELIVERY') && isCODPM)) {
      // Delivered Full COD Delivery Order (no advance payment):
      // The Delivery Rider collected the entire order total at doorstep!
      // Rider gets orderTotal, Cashier gets 0.
      riderAmount = orderTotal;
      riderPm = getRiderPaymentMethodString(pm);
      cashierAmount = 0;
    } else {
      // Regular non-delivery payment (dine-in, takeaway) —
      // cashier collected the entire amount.
      cashierAmount = orderTotal;
      cashierPm = pm;
    }

    // Only allocate cashier portion if it hasn't been independently settled yet.
    // cashierSettlementId is null for regular orders (handled via legacy settlementId)
    // and for split orders not yet settled.
    if (cashierAmount > 0 && (order as any).cashierSettlementId === null) {
      let cashierStaffId: string;
      let cashierStaffName: string;
      let cashierStaffRole: string;
      // accountLinked = false means this staffId does NOT resolve to a real User row,
      // so it can never be written to CashSettlement.staffId (a required FK to User).
      // These orders still surface in Active Balances for visibility, but createSettlement
      // rejects settling them until a real account is linked — see the account guard there.
      let accountLinked = true;

      if (order.staffId && order.staff) {
        cashierStaffId = order.staff.id;
        cashierStaffName = order.staff.name;
        cashierStaffRole = order.staff.role;
      } else if (order.staffId) {
        cashierStaffId = order.staffId;
        cashierStaffName = order.staffName || 'Unknown Staff';
        cashierStaffRole = 'Staff';
      } else if (order.staffName) {
        cashierStaffId = order.staffName;
        cashierStaffName = order.staffName;
        cashierStaffRole = 'Staff';
        accountLinked = false;
      } else {
        cashierStaffId = 'unassigned';
        cashierStaffName = 'Unassigned';
        cashierStaffRole = 'Staff';
        accountLinked = false;
      }

      // Pass the clean method name (e.g. "JazzCash") so parsePaymentMethodAmounts
      // exact-matches it rather than re-parsing embedded amounts from the PM string.
      allocateToStaffGroup(
        cashierStaffId,
        cashierStaffName,
        cashierStaffRole,
        accountLinked,
        cashierPm,
        cashierAmount,
        order,
        getCashierChannel(order)
      );
    }

    // Rider only appears after they deliver and update paymentMethod with COD Balance.
    // Only allocate if riderSettlementId hasn't been independently settled yet.
    if (riderAmount > 0 && order.riderId && order.rider && (order as any).riderSettlementId === null) {
      const riderStaffId = order.rider.userId || order.rider.id;
      const riderStaffName = order.rider.user?.name || order.rider.name;
      const riderStaffRole = order.rider.user?.role || 'Rider';
      // DeliveryRider.userId is optional — a rider can be created without login access
      // (see delivery.controller.ts createRider). Their cash still needs to be visible
      // here, but it can't be settled (CashSettlement.staffId requires a real User) until
      // an admin links an account, so flag it rather than letting settlement crash.
      const accountLinked = !!order.rider.userId;

      allocateToStaffGroup(
        riderStaffId,
        riderStaffName,
        riderStaffRole,
        accountLinked,
        riderPm,  // clean method name, e.g. "Cash"
        riderAmount,
        order,
        RIDER_CHANNEL
      );
    }
  }

  const result = Array.from(staffMap.values())
    .filter((g) => g.orders.length > 0)
    .map((g) => ({
      staffId: g.staffId,
      staffName: g.staffName,
      staffRole: g.staffRole,
      accountLinked: g.accountLinked,
      oldestOrderAt: g.oldestOrderAt,
      expectedCash: Number(g.expectedCash.toFixed(2)),
      expectedCard: Number(g.expectedCard.toFixed(2)),
      expectedOnline: Number(g.expectedOnline.toFixed(2)),
      byMethod: g.byMethod,
      totalExpected: Number(
        Object.values(g.byMethod).reduce((sum, v) => sum + v, 0).toFixed(2)
      ),
      orderCount: g.orders.length,
      orders: g.orders,
    }));

  return result;
}

export async function getStaffActiveBalance(staffId: string, outletScope: string | null) {
  const activeBalances = await getActiveBalances(outletScope);

  let riderUserId = staffId;
  let riderId = staffId;
  try {
    const rider = await prisma.deliveryRider.findFirst({
      where: { OR: [{ id: staffId }, { userId: staffId }] },
    });
    if (rider) {
      riderId = rider.id;
      if (rider.userId) riderUserId = rider.userId;
    }
  } catch {}

  const found = activeBalances.find((b) => b.staffId === staffId || b.staffId === riderUserId || b.staffId === riderId);

  if (found) {
    return found;
  }

  let staffName: string | undefined;
  let staffRole = 'Staff';

  try {
    const user = await prisma.user.findFirst({
      where: { OR: [{ id: staffId }, { name: staffId }] },
    });
    if (user) {
      staffName = user.name;
      staffRole = user.role;
    }
  } catch {}

  if (!staffName) {
    try {
      const rider = await prisma.deliveryRider.findFirst({
        where: { OR: [{ id: staffId }, { userId: staffId }, { name: staffId }] },
        include: { user: true },
      });
      if (rider) {
        staffName = rider.user?.name || rider.name;
        staffRole = rider.user?.role || 'Rider';
      }
    } catch {}
  }

  let configuredMethods = ['Cash', 'Credit Card', 'Account', 'JazzCash', 'EasyPaisa'];
  try {
    const settingsWhere: Prisma.SettingsWhereInput = outletScope ? { outletId: outletScope } : {};
    const settings = await prisma.settings.findFirst({ where: settingsWhere });
    if (settings && Array.isArray(settings.paymentMethods) && settings.paymentMethods.length > 0) {
      configuredMethods = settings.paymentMethods;
    }
  } catch {}

  const initialByMethod: Record<string, number> = {};
  for (const m of configuredMethods) {
    initialByMethod[m] = 0;
  }

  return {
    staffId,
    staffName: staffName || 'Staff Member',
    staffRole,
    accountLinked: true,
    oldestOrderAt: null,
    expectedCash: 0,
    expectedCard: 0,
    expectedOnline: 0,
    byMethod: initialByMethod,
    totalExpected: 0,
    orderCount: 0,
    orders: [],
  };
}

export async function createSettlement(
  reqUser: { id: string; name?: string; email?: string; role?: string; outletId?: string | null },
  data: {
    staffId: string;
    actualCash?: number;
    actualCard?: number;
    actualOnline?: number;
    actualByMethod?: Record<string, number>;
    notes?: string;
  },
  outletScope: string | null
) {
  const activeBalances = await getActiveBalances(outletScope);
  const staffBalance = activeBalances.find((b) => b.staffId === data.staffId);

  if (!staffBalance || staffBalance.orders.length === 0) {
    throw ApiError.badRequest('No uncleared orders found for this staff member');
  }

  // CashSettlement.staffId is a required foreign key to User — a rider with no linked
  // login (DeliveryRider.userId is optional) or a legacy order missing staffId would
  // otherwise crash this insert with a raw FK constraint violation and leave the cash
  // permanently stuck as "uncleared". Reject with an actionable message instead.
  if (!staffBalance.accountLinked) {
    throw ApiError.badRequest(
      `${staffBalance.staffName} has no linked login account, so their cash cannot be settled yet. ` +
      `Ask an admin to link a user account for them (Delivery → Riders, or Users) and try again.`
    );
  }

  let staffName = staffBalance.staffName;
  let staffRole = staffBalance.staffRole;

  try {
    const staffUser = await prisma.user.findFirst({
      where: { OR: [{ id: data.staffId }, { name: data.staffId }] },
    });
    if (staffUser) {
      staffName = staffUser.name;
      staffRole = staffUser.role;
    }
  } catch {}

  const expectedCash = staffBalance.expectedCash;
  const expectedCard = staffBalance.expectedCard;
  const expectedOnline = staffBalance.expectedOnline;
  const totalExpected = staffBalance.totalExpected;

  const actualByMethod = data.actualByMethod || {};
  let totalActualFromMethods = 0;

  for (const [m, val] of Object.entries(actualByMethod)) {
    totalActualFromMethods += Number(val || 0);
  }

  const actualCash = data.actualCash !== undefined ? Number(data.actualCash) : (actualByMethod['Cash'] ?? expectedCash);
  const actualCard = data.actualCard !== undefined ? Number(data.actualCard) : (actualByMethod['Credit Card'] ?? expectedCard);
  const actualOnline = data.actualOnline !== undefined ? Number(data.actualOnline) : (actualByMethod['JazzCash'] || 0) + (actualByMethod['EasyPaisa'] || 0);

  const totalActual = totalActualFromMethods > 0
    ? Number(totalActualFromMethods.toFixed(2))
    : Number((actualCash + actualCard + actualOnline).toFixed(2));

  const cashDifference = Number((totalActual - totalExpected).toFixed(2));

  const paymentBreakdown = {
    expectedByMethod: staffBalance.byMethod,
    actualByMethod: Object.keys(actualByMethod).length > 0 ? actualByMethod : staffBalance.byMethod,
  };

  const settlementNo = `STL-${Date.now()}`;
  const orderIds = staffBalance.orders.map((o) => o.id);
  const outletId = staffBalance.orders[0]?.outletId || outletScope || reqUser.outletId || null;

  // Route each order to its settlement field based on ITS OWN channel tag (set in
  // getActiveBalances) — not a single per-batch guess about the staff member. A staffId
  // can legitimately mix cashier/waiter sales with rider COD (e.g. one login used for
  // both roles); misclassifying even one order here means it can never be re-claimed by
  // a future settlement (the where-guards below only match orders still at null).
  const regularOrderIds: string[] = [];
  const cashierAdvanceOrderIds: string[] = [];
  const riderOrderIds: string[] = [];

  for (const o of staffBalance.orders as any[]) {
    if (o.channel === RIDER_CHANNEL) {
      // This specific order was collected via Delivery Rider COD
      riderOrderIds.push(o.id);
      continue;
    }
    // This specific order was a POS / Waiter Panel / Self-Order sale
    const pm = o.paymentMethod || '';
    const hasAdvance = /advance\s*\(/i.test(pm);
    const hasCODBalance = /cod balance\s*\(/i.test(pm);
    if (hasAdvance || hasCODBalance) {
      // Cashier's advance portion
      cashierAdvanceOrderIds.push(o.id);
    } else {
      // Regular non-split order
      regularOrderIds.push(o.id);
    }
  }

  const createdSettlement = await prisma.$transaction(async (tx) => {
    const settlement = await tx.cashSettlement.create({
      data: {
        settlementNo,
        outletId,
        staffId: data.staffId,
        staffName,
        staffRole,
        settledById: reqUser.id,
        settledByName: reqUser.name || reqUser.email || 'Manager',
        expectedCash,
        expectedCard,
        expectedOnline,
        totalExpected,
        actualCash,
        actualCard,
        actualOnline,
        totalActual,
        cashDifference,
        paymentBreakdown,
        notes: data.notes || null,
      },
      include: {
        orders: true,
        staff: { select: { id: true, name: true, role: true } },
        settledBy: { select: { id: true, name: true, role: true } },
      },
    });

    // Guard against concurrent settlements — if any order was already settled
    // in the meantime, abort so we don't double-record cash.
    // Each order type uses its own field: regular → settlementId,
    // advance cashier portion → cashierSettlementId, rider COD → riderSettlementId.

    if (regularOrderIds.length > 0) {
      const claimed = await tx.order.updateMany({
        where: { id: { in: regularOrderIds }, settlementId: null },
        data: { settlementId: settlement.id },
      });
      if (claimed.count !== regularOrderIds.length) {
        throw ApiError.badRequest('Some orders were already settled by another request. Please refresh and try again.');
      }
    }

    if (cashierAdvanceOrderIds.length > 0) {
      const claimed = await tx.order.updateMany({
        where: { id: { in: cashierAdvanceOrderIds }, cashierSettlementId: null },
        data: { cashierSettlementId: settlement.id },
      });
      if (claimed.count !== cashierAdvanceOrderIds.length) {
        throw ApiError.badRequest('Some advance orders were already settled by another request. Please refresh and try again.');
      }
    }

    if (riderOrderIds.length > 0) {
      const claimed = await tx.order.updateMany({
        where: { id: { in: riderOrderIds }, riderSettlementId: null },
        data: { riderSettlementId: settlement.id },
      });
      if (claimed.count !== riderOrderIds.length) {
        throw ApiError.badRequest('Some COD orders were already settled by another request. Please refresh and try again.');
      }
    }

    return settlement;
  });

  const formatted = mapSettlement(createdSettlement);

  emitToOutlets('cashSettlement:created', formatted, [outletId]);

  return formatted;
}

export async function getSettlementHistory(
  outletScope: string | null,
  params: {
    staffId?: string;
    role?: string;
    page?: number;
    limit?: number;
    date?: string;
  }
) {
  const page = Number(params.page) || 1;
  const limit = Number(params.limit) || 20;
  const skip = (page - 1) * limit;

  const where: Prisma.CashSettlementWhereInput = {};

  if (outletScope) {
    where.outletId = outletScope;
  }

  if (params.staffId) {
    where.staffId = params.staffId;
  }

  if (params.role) {
    where.staffRole = { equals: params.role, mode: 'insensitive' };
  }

  if (params.date) {
    const startDate = new Date(params.date);
    startDate.setHours(0, 0, 0, 0);
    const endDate = new Date(params.date);
    endDate.setHours(23, 59, 59, 999);
    where.createdAt = { gte: startDate, lte: endDate };
  }

  const [settlements, total] = await Promise.all([
    prisma.cashSettlement.findMany({
      where,
      skip,
      take: limit,
      orderBy: { createdAt: 'desc' },
      include: {
        orders: {
          select: {
            id: true,
            orderNumber: true,
            customerName: true,
            total: true,
            subtotal: true,
            tax: true,
            discount: true,
            paymentMethod: true,
            status: true,
            type: true,
            createdAt: true,
            outletId: true,
          },
        },
        staff: { select: { id: true, name: true, role: true } },
        settledBy: { select: { id: true, name: true, role: true } },
      },
    }),
    prisma.cashSettlement.count({ where }),
  ]);

  return {
    data: settlements.map(mapSettlement),
    total,
    page,
    limit,
    totalPages: Math.ceil(total / limit),
  };
}
