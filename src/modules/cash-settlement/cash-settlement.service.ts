import { Prisma } from '@prisma/client';
import { prisma } from '../../config/database.js';
import { ApiError } from '../../utils/ApiError.js';
import { emitToOutlets } from '../../socket.js';

function parsePaymentMethodAmounts(
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

  // 2. Split payment string parsing (e.g. "Cash: Rs.1000, EasyPaisa: Rs.333" or "Advance (Cash): Rs.500, Net (Credit Card): Rs.400")
  if (raw.includes(':') || raw.includes(',')) {
    const parts = raw.split(',');
    let parsedSum = 0;
    for (const part of parts) {
      const subParts = part.split(':');
      if (subParts.length >= 2) {
        let methodLabel = subParts[0].trim();
        const parenMatch = methodLabel.match(/\(([^)]+)\)/);
        if (parenMatch) {
          methodLabel = parenMatch[1].trim();
        }

        const valueStr = subParts[subParts.length - 1].replace(/Rs\.?|PKR/gi, '').trim();
        const val = parseFloat(valueStr);
        if (!isNaN(val) && val > 0) {
          const lml = methodLabel.toLowerCase();
          const matchedMethod =
            configuredMethods.find((m) => m.toLowerCase() === lml) ||
            configuredMethods.find((m) => {
              const lm = m.toLowerCase();
              if (lm === 'cash' && lml === 'cash') return true;
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
      expectedCash: number;
      expectedCard: number;
      expectedOnline: number;
      byMethod: Record<string, number>;
      orders: any[];
    }
  >();

  for (const order of orders) {
    let staffId: string;
    let staffName: string;
    let staffRole: string;

    if (order.riderId && order.rider) {
      staffId = order.rider.userId || order.rider.id;
      staffName = order.rider.user?.name || order.rider.name;
      staffRole = order.rider.user?.role || 'Rider';
    } else if (order.staffId && order.staff) {
      staffId = order.staff.id;
      staffName = order.staff.name;
      staffRole = order.staff.role;
    } else if (order.staffId) {
      staffId = order.staffId;
      staffName = order.staffName || 'Unknown Staff';
      staffRole = 'Staff';
    } else if (order.staffName) {
      staffId = order.staffName;
      staffName = order.staffName;
      staffRole = 'Staff';
    } else {
      staffId = 'unassigned';
      staffName = 'Unassigned';
      staffRole = 'Staff';
    }

    if (!staffMap.has(staffId)) {
      const initialByMethod: Record<string, number> = {};
      for (const m of configuredMethods) {
        initialByMethod[m] = 0;
      }
      staffMap.set(staffId, {
        staffId,
        staffName,
        staffRole,
        expectedCash: 0,
        expectedCard: 0,
        expectedOnline: 0,
        byMethod: initialByMethod,
        orders: [],
      });
    }

    const group = staffMap.get(staffId)!;
    const orderTotal = Number(order.total);
    const parsedAmounts = parsePaymentMethodAmounts(order.paymentMethod, orderTotal, configuredMethods);

    let hasNonZero = false;
    for (const [method, amount] of Object.entries(parsedAmounts)) {
      if (amount > 0) hasNonZero = true;
      group.byMethod[method] = Number(((group.byMethod[method] || 0) + amount).toFixed(2));

      const lowerM = method.toLowerCase().trim();
      const isCash = lowerM === 'cash';
      const isCard = lowerM.includes('card') || lowerM.includes('bank');

      if (isCash) {
        group.expectedCash += amount;
      } else if (isCard) {
        group.expectedCard += amount;
      } else {
        group.expectedOnline += amount;
      }
    }

    if (hasNonZero) {
      group.orders.push(mapOrder(order));
    }
  }

  const result = Array.from(staffMap.values())
    .filter((g) => g.orders.length > 0)
    .map((g) => ({
      staffId: g.staffId,
      staffName: g.staffName,
      staffRole: g.staffRole,
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

    // Guard against a concurrent settlement claiming the same orders between the
    // balance snapshot above and this transaction — if any order was already
    // settled in the meantime, abort (rolls back the settlement row too) instead
    // of silently double-recording the same cash as settled twice.
    const claimed = await tx.order.updateMany({
      where: { id: { in: orderIds }, settlementId: null },
      data: { settlementId: settlement.id },
    });

    if (claimed.count !== orderIds.length) {
      throw ApiError.badRequest('Some of these orders were already settled by another request. Please refresh and try again.');
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
