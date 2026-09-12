/**
 * Reports Controller (Phase 1)
 * Server-side aggregation for Sales, P&L, Item-wise, and Stock reports.
 */
import type { Request, Response } from 'express';
import { prisma } from '../../config/database.js';
import { ApiResponse } from '../../utils/ApiResponse.js';
import { ApiError } from '../../utils/ApiError.js';
import { asyncHandler } from '../../utils/asyncHandler.js';
import {
  parseDateRange, buildOrderWhere, computeCogs,
  dayBoundaries, monthBoundaries, classifyChannel, growthPct, fillChannels, groupPayments,
  groupPaymentsWithCounts, displayOrderType, isLowStock,
  parseTimeOfDay, isWithinTimeOfDay, splitOrderTotalByLine,
  type CogsRecipe, type CogsItem,
} from './reports.helpers.js';
import { resolveOutletScope } from '../../middleware/outletScope.js';
import { autoProcessExpiredBatches } from '../stock/autoExpiry.js';
import { getActiveBalances } from '../cash-settlement/cash-settlement.service.js';
import { toDealForPricing } from '../deals/deal.revalidate.js';
import { computeOrderDiscount } from '../deals/deal.pricing.js';

const COMPLETED = 'COMPLETED'; // Prisma OrderStatus enum value for completed orders

function getParams(req: Request) {
  const from = req.query.from as string | undefined;
  const to = req.query.to as string | undefined;
  // Enforce outlet scope: non-super-admins are pinned to their own outlet.
  // resolveOutletScope returns null for "All" (Super Admin) → undefined keeps the
  // existing "no outlet filter" behavior downstream.
  const outletId = resolveOutletScope(req) ?? undefined;
  const { gte, lte } = parseDateRange(from, to);
  return { gte, lte, outletId };
}

/** GET /api/reports/sales */
export const getSalesReport = asyncHandler(async (req: Request, res: Response) => {
  const { gte, lte, outletId } = getParams(req);
  const baseWhere = buildOrderWhere(gte, lte, outletId);
  const completedWhere = { ...baseWhere, status: COMPLETED as never, cashApproved: true };

  const [totalOrders, completed] = await Promise.all([
    prisma.order.count({ where: baseWhere }),
    prisma.order.findMany({
      where: completedWhere,
      select: { total: true, createdAt: true },
    }),
  ]);

  const totalSales = completed.reduce((s, o) => s + Number(o.total), 0);
  const completedOrders = completed.length;
  const avgOrderValue = completedOrders > 0 ? Math.round(totalSales / completedOrders) : 0;

  const byDay = new Map<string, number>();
  for (const o of completed) {
    const key = o.createdAt.toISOString().slice(5, 10); // MM-DD
    byDay.set(key, (byDay.get(key) ?? 0) + Number(o.total));
  }
  const trend = [...byDay.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, revenue]) => ({ date, revenue: Math.round(revenue) }));

  res.json(
    ApiResponse.success({
      totalSales: Math.round(totalSales),
      totalOrders,
      completedOrders,
      avgOrderValue,
      trend,
    })
  );
});

/** GET /api/reports/pnl */
export const getPnlReport = asyncHandler(async (req: Request, res: Response) => {
  const { gte, lte, outletId } = getParams(req);
  const completedWhere = { ...buildOrderWhere(gte, lte, outletId), status: COMPLETED as never, cashApproved: true };

  const completed = await prisma.order.findMany({
    where: completedWhere,
    select: {
      total: true,
      items: { select: { menuItemId: true, variantId: true, qty: true } },
    },
  });

  const revenue = completed.reduce((s, o) => s + Number(o.total), 0);

  // COGS: gather all menuItemIds across the completed items, load their recipes + ingredient prices.
  const menuItemIds = [
    ...new Set(
      completed.flatMap((o) => o.items.map((i) => i.menuItemId).filter((x): x is string => !!x))
    ),
  ];
  let cogs = 0;
  if (menuItemIds.length > 0) {
    const recipes = await prisma.foodRecipe.findMany({
      where: { menuItemId: { in: menuItemIds } },
      select: { menuItemId: true, variantId: true, ingredientId: true, qtyPerUnit: true },
    });
    const ingredientIds = [...new Set(recipes.map((r) => r.ingredientId).filter((id): id is string => id !== null))];
    const ingredients = await prisma.ingredient.findMany({
      where: { id: { in: ingredientIds } },
      select: { id: true, purchasePrice: true },
    });
    const priceById = new Map(ingredients.map((i) => [i.id, Number(i.purchasePrice ?? 0)]));
    const allItems = completed.flatMap((o) => o.items);
    const recipesForCogs = recipes
      .filter((r): r is typeof r & { ingredientId: string } => r.ingredientId !== null)
      .map((r) => ({
        menuItemId: r.menuItemId,
        variantId: r.variantId,
        ingredientId: r.ingredientId,
        qtyPerUnit: Number(r.qtyPerUnit),
      }));
    cogs = computeCogs(allItems, recipesForCogs, priceById);
  }

  // Expenses are now outlet-scoped (Phase B3); outletId is the resolved scope (undefined = all).
  const expenseRows = await prisma.expense.findMany({
    where: { ...(outletId ? { outletId } : {}), date: { gte, lte } },
    select: { amount: true, category: true },
  });
  const expenses = expenseRows.reduce((s, e) => s + Number(e.amount), 0);
  const catMap = new Map<string, number>();
  for (const e of expenseRows) {
    const name = e.category ?? 'Uncategorized';
    catMap.set(name, (catMap.get(name) ?? 0) + Number(e.amount));
  }
  const expenseByCategory = [...catMap.entries()].map(([name, value]) => ({
    name,
    value: Math.round(value),
  }));

  const expensesAreRestaurantWide = false;   // expenses are now outlet-scoped (Phase B3)

  res.json(
    ApiResponse.success({
      revenue: Math.round(revenue),
      cogs,
      expenses: Math.round(expenses),
      netProfit: Math.round(revenue - cogs - expenses),
      expenseByCategory,
      expensesAreRestaurantWide,
    })
  );
});

/** GET /api/reports/items */
export const getItemsReport = asyncHandler(async (req: Request, res: Response) => {
  const { gte, lte, outletId } = getParams(req);
  const completedWhere = { ...buildOrderWhere(gte, lte, outletId), status: COMPLETED as never, cashApproved: true };

  const items = await prisma.orderItem.findMany({
    where: { order: { is: completedWhere } },
    select: { name: true, qty: true, price: true },
  });

  const map = new Map<string, { qty: number; revenue: number }>();
  for (const it of items) {
    const cur = map.get(it.name) ?? { qty: 0, revenue: 0 };
    cur.qty += it.qty;
    cur.revenue += Number(it.price) * it.qty;
    map.set(it.name, cur);
  }
  const topItems = [...map.entries()]
    .map(([name, v]) => ({ name, qty: v.qty, revenue: Math.round(v.revenue) }))
    .sort((a, b) => b.revenue - a.revenue)
    .slice(0, 20);

  res.json(ApiResponse.success({ topItems }));
});

/** GET /api/reports/stock — current snapshot, ignores from/to */
export const getStockReport = asyncHandler(async (req: Request, res: Response) => {
  const outletId = req.query.outletId as string | undefined;

  // Phase 1 uses the global Ingredient table for valuation, matching current frontend behavior.
  // Outlet-specific stock is a Phase 2 refinement.
  const ingredients = await prisma.ingredient.findMany({
    select: {
      currentStock: true,
      lowStockLevel: true,
      purchasePrice: true,
      category: { select: { name: true } },
    },
  });

  const totalIngredients = ingredients.length;
  let lowStockItems = 0;
  let totalValue = 0;
  const catMap = new Map<string, number>();
  for (const i of ingredients) {
    const stock = Number(i.currentStock);
    const low = Number(i.lowStockLevel);
    const price = Number(i.purchasePrice ?? 0);
    if (isLowStock(stock, low)) lowStockItems += 1;
    const value = stock * price;
    totalValue += value;
    const name = i.category?.name ?? 'Uncategorized';
    catMap.set(name, (catMap.get(name) ?? 0) + value);
  }
  const stockByCategory = [...catMap.entries()].map(([name, value]) => ({
    name,
    value: Math.round(value),
  }));

  // outletId accepted for API symmetry; Phase 1 valuation is global.
  void outletId;

  res.json(
    ApiResponse.success({
      totalIngredients,
      lowStockItems,
      totalValue: Math.round(totalValue),
      stockByCategory,
    })
  );
});

/** GET /api/reports/dashboard?outletId=<id|all> */
export const getDashboard = asyncHandler(async (req: Request, res: Response) => {
  await autoProcessExpiredBatches();
  const outletId = resolveOutletScope(req) ?? undefined;
  const now = new Date();
  const day = dayBoundaries(now);
  const mb = monthBoundaries(now);

  const outletFilter = outletId ? { outletId } : {};
  // Only count COMPLETED orders in dashboard sales where cash is approved — PENDING/PREPARING/READY dine-in
  // orders or waiter panel cash orders awaiting POS approval (cashApproved === false) must not be reflected
  // in sales totals until the POS approves cash.
  const onlyCompleted = { status: COMPLETED as never, cashApproved: true };

  // --- TODAY: orders by channel ---
  const todayOrders = await prisma.order.findMany({
    where: { ...outletFilter, ...onlyCompleted, createdAt: { gte: day.gte, lte: day.lte } },
    select: { type: true, total: true },
  });
  const channelMap = new Map<string, { type: string; sales: number; orders: number }>();
  let onlineSales = 0, onlineOrders = 0, offlineSales = 0, offlineOrders = 0;
  for (const o of todayOrders) {
    const type = displayOrderType(String(o.type));
    const amt = Number(o.total);
    const cur = channelMap.get(type) ?? { type, sales: 0, orders: 0 };
    cur.sales += amt; cur.orders += 1;
    channelMap.set(type, cur);
    if (classifyChannel(type) === 'online') { onlineSales += amt; onlineOrders += 1; }
    else { offlineSales += amt; offlineOrders += 1; }
  }
  const channels = fillChannels([...channelMap.values()]).map((c) => ({ ...c, sales: Math.round(c.sales) }));
  const todayTotalSales = Math.round(todayOrders.reduce((s, o) => s + Number(o.total), 0));

  // --- THIS MONTH: financials, payments, online/offline totals (for growth) ---
  const monthOrders = await prisma.order.findMany({
    where: { ...outletFilter, ...onlyCompleted, createdAt: { gte: mb.thisStart, lte: mb.thisEnd } },
    select: { type: true, total: true, subtotal: true, discount: true, paymentMethod: true },
  });
  const grossSale = monthOrders.reduce((s, o) => s + Number(o.subtotal), 0);
  const discounts = monthOrders.reduce((s, o) => s + Number(o.discount), 0);
  const revenue = monthOrders.reduce((s, o) => s + Number(o.total), 0);
  const paymentBreakdown = groupPayments(monthOrders.map((o) => ({ method: o.paymentMethod, amount: Number(o.total) })));
  let monthOnline = 0, monthOffline = 0;
  for (const o of monthOrders) {
    if (classifyChannel(displayOrderType(String(o.type))) === 'online') monthOnline += Number(o.total);
    else monthOffline += Number(o.total);
  }

  // --- LAST MONTH: online/offline + overall totals (for growth %) ---
  const lastOrders = await prisma.order.findMany({
    where: { ...outletFilter, ...onlyCompleted, createdAt: { gte: mb.lastStart, lte: mb.lastEnd } },
    select: { type: true, total: true },
  });
  let lastOnline = 0, lastOffline = 0, lastTotal = 0;
  for (const o of lastOrders) {
    const amt = Number(o.total); lastTotal += amt;
    if (classifyChannel(displayOrderType(String(o.type))) === 'online') lastOnline += amt; else lastOffline += amt;
  }

  // --- expenses + waste this month (both outlet-scoped) ---
  const [expenseRows, wasteRows] = await Promise.all([
    prisma.expense.findMany({ where: { ...outletFilter, date: { gte: mb.thisStart, lte: mb.thisEnd } }, select: { amount: true } }),
    prisma.wasteRecord.findMany({ where: { ...outletFilter, date: { gte: mb.thisStart, lte: mb.thisEnd } }, select: { cost: true } }),
  ]);
  const expenses = expenseRows.reduce((s, e) => s + Number(e.amount), 0);
  const foodLoss = wasteRows.reduce((s, w) => s + Number(w.cost ?? 0), 0);
  const netProfit = revenue - expenses - foodLoss;

  // --- day-wise (current week Mon..Sun) ---
  const weekStart = new Date(day.gte);
  const dow = (weekStart.getUTCDay() + 6) % 7; // Mon=0
  weekStart.setUTCDate(weekStart.getUTCDate() - dow);
  const weekEnd = new Date(weekStart); weekEnd.setUTCDate(weekStart.getUTCDate() + 6); weekEnd.setUTCHours(23, 59, 59, 999);
  const weekOrders = await prisma.order.findMany({
    where: { ...outletFilter, ...onlyCompleted, createdAt: { gte: weekStart, lte: weekEnd } },
    select: { total: true, createdAt: true, type: true, customerId: true, customerName: true, phone: true },
  });
  const labels = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const dayTotals = [0, 0, 0, 0, 0, 0, 0];
  for (const o of weekOrders) {
    const idx = (new Date(o.createdAt).getUTCDay() + 6) % 7;
    dayTotals[idx] += Number(o.total);
  }
  const daywiseSales = labels.map((label, i) => ({ label, sales: Math.round(dayTotals[i]) }));

  // --- peakHours / orderTypeTrend / customerActivity: all derived from weekOrders above, zero new queries ---
  const peakHours = Array.from({ length: 24 }, (_, hour) => ({ hour, orders: 0, revenue: 0 }));
  const orderTypeMap = new Map<string, Map<string, { count: number; revenue: number }>>();
  for (const o of weekOrders) {
    const created = new Date(o.createdAt);
    const hour = created.getUTCHours();
    peakHours[hour].orders += 1;
    peakHours[hour].revenue += Number(o.total);

    const dayLabel = labels[(created.getUTCDay() + 6) % 7];
    const type = displayOrderType(String(o.type));
    const dayMap = orderTypeMap.get(dayLabel) ?? new Map<string, { count: number; revenue: number }>();
    const cur = dayMap.get(type) ?? { count: 0, revenue: 0 };
    cur.count += 1;
    cur.revenue += Number(o.total);
    dayMap.set(type, cur);
    orderTypeMap.set(dayLabel, dayMap);
  }
  for (const p of peakHours) p.revenue = Math.round(p.revenue);
  const orderTypeTrend = labels.flatMap((day) => {
    const dayMap = orderTypeMap.get(day);
    if (!dayMap) return [];
    return [...dayMap.entries()].map(([type, v]) => ({ day, type, count: v.count, revenue: Math.round(v.revenue) }));
  });

  // Same dedup key as topCustomers below (customerId -> clean phone -> name); orders that don't
  // resolve to an identifiable customer (walk-in / no name) are excluded from activity counts.
  const weekCustomerKey = (o: { customerId: string | null; customerName: string | null; phone: string | null }): string | null => {
    if (o.customerId) return `id:${o.customerId}`;
    if (!o.customerName || o.customerName.trim() === '' || o.customerName.toLowerCase() === 'walk-in') return null;
    const cleanPhone = o.phone ? o.phone.replace(/\D/g, '') : '';
    const isDummyPhone = !cleanPhone || cleanPhone === '00000000000' || cleanPhone === '11111111111' || cleanPhone === '12345678901';
    if (!isDummyPhone && cleanPhone.length >= 7) return `phone:${cleanPhone}`;
    return `name:${o.customerName.toLowerCase().trim()}`;
  };
  const dayCustomerSets = labels.map(() => new Set<string>());
  for (const o of weekOrders) {
    const key = weekCustomerKey(o);
    if (!key) continue;
    const idx = (new Date(o.createdAt).getUTCDay() + 6) % 7;
    dayCustomerSets[idx].add(key);
  }
  const seenSoFar = new Set<string>();
  const customerActivity = labels.map((label, i) => {
    const daySet = dayCustomerSets[i];
    let newCustomers = 0, returningCustomers = 0;
    for (const key of daySet) {
      if (seenSoFar.has(key)) returningCustomers += 1; else newCustomers += 1;
    }
    for (const key of daySet) seenSoFar.add(key);
    return { day: label, uniqueCustomers: daySet.size, newCustomers, returningCustomers };
  });

  // --- payable / receivable / settings / top customers ---
  const [purchaseAgg, customerAgg, validCustomerOrders, settings] = await Promise.all([
    prisma.purchase.aggregate({ where: { ...outletFilter }, _sum: { due: true } }),
    prisma.customer.aggregate({ _sum: { outstandingDue: true } }),
    prisma.order.findMany({
      where: {
        ...outletFilter,
        ...onlyCompleted,
        customerName: { not: null },
      },
      select: {
        customerId: true,
        customerName: true,
        phone: true,
        total: true,
      },
    }),
    prisma.settings.findFirst({ select: { restaurantName: true } }),
  ]);
  const payable = Math.round(Number(purchaseAgg._sum.due ?? 0));
  const receivable = Math.round(Number(customerAgg._sum.outstandingDue ?? 0));

  const custMap = new Map<string, { name: string; customerId: string | null; totalOrders: number; totalSpent: number }>();
  for (const o of validCustomerOrders) {
    if (!o.customerName || o.customerName.trim() === '' || o.customerName.toLowerCase() === 'walk-in') continue;

    const cleanPhone = o.phone ? o.phone.replace(/\D/g, '') : '';
    const isDummyPhone = !cleanPhone || cleanPhone === '00000000000' || cleanPhone === '11111111111' || cleanPhone === '12345678901';

    const key = o.customerId
      ? `id:${o.customerId}`
      : (!isDummyPhone && cleanPhone.length >= 7)
      ? `phone:${cleanPhone}`
      : `name:${o.customerName.toLowerCase().trim()}`;

    const amt = Number(o.total || 0);
    const existing = custMap.get(key) ?? {
      name: o.customerName.trim(),
      customerId: o.customerId ?? null,
      totalOrders: 0,
      totalSpent: 0,
    };

    existing.totalOrders += 1;
    existing.totalSpent += amt;
    custMap.set(key, existing);
  }

  const topCustomersMapped = [...custMap.values()]
    .map((c) => ({
      customerId: c.customerId,
      name: c.name,
      totalOrders: c.totalOrders,
      totalSpent: Math.round(c.totalSpent),
    }))
    .sort((a, b) => b.totalSpent - a.totalSpent)
    .slice(0, 10);

  // --- top items this month ---
  const monthItems = await prisma.orderItem.findMany({
    where: { order: { is: { ...outletFilter, ...onlyCompleted, createdAt: { gte: mb.thisStart, lte: mb.thisEnd } } } },
    select: { name: true, qty: true, price: true },
  });
  const itemMap = new Map<string, { qty: number; revenue: number }>();
  for (const it of monthItems) {
    const cur = itemMap.get(it.name) ?? { qty: 0, revenue: 0 };
    cur.qty += it.qty; cur.revenue += Number(it.price) * it.qty;
    itemMap.set(it.name, cur);
  }
  const topItems = [...itemMap.entries()]
    .map(([name, v]) => ({ name, qty: v.qty, revenue: Math.round(v.revenue) }))
    .sort((a, b) => b.revenue - a.revenue)
    .slice(0, 10);

  // --- whole-app overview aggregates (Phase 1): cheap count/groupBy calls + one bounded findMany,
  // all outlet-scoped and batched together, plus one 60-day query for dayOfWeekPerformance ---
  const todayStr = new Date(Date.now() + 5 * 60 * 60 * 1000).toISOString().split('T')[0]; // PKT "today"
  const sixtyDaysAgo = new Date(day.gte);
  sixtyDaysAgo.setUTCDate(sixtyDaysAgo.getUTCDate() - 60);

  const [
    liveStatusRows,
    tableStatusRows,
    warehouseStockRows,
    pendingPurchaseRequests,
    pendingDemands,
    attendanceRows,
    pendingLeaveRequests,
    reservationsToday,
    deliveryActive,
    pendingCancellations,
    cashHubBalances,
    perfOrders,
  ] = await Promise.all([
    prisma.order.groupBy({
      by: ['status'],
      _count: { _all: true },
      where: { ...outletFilter, createdAt: { gte: day.gte, lte: day.lte } },
    }),
    prisma.restaurantTable.groupBy({
      by: ['status'],
      _count: { _all: true },
      where: { ...outletFilter },
    }),
    // Branch stock, not the chain-wide Ingredient catalog (Ingredient.outletId is null for
    // virtually every row) — see this repo's CLAUDE.md low-stock note.
    prisma.warehouseStock.findMany({
      where: { ...(outletId ? { warehouse: { outletId } } : {}) },
      select: { currentStock: true, lowStockLevel: true },
    }),
    prisma.purchaseRequest.count({
      where: { status: 'PENDING', ...(outletId ? { warehouse: { outletId } } : {}) },
    }),
    prisma.stockDemand.count({
      where: { status: 'PENDING', ...(outletId ? { requestingWH: { outletId } } : {}) },
    }),
    prisma.attendanceRecord.groupBy({
      by: ['status'],
      _count: { _all: true },
      where: { date: todayStr, ...(outletId ? { outletId } : {}) },
    }),
    prisma.leaveRequest.count({
      where: { status: 'pending', ...(outletId ? { outletId } : {}) },
    }),
    prisma.reservation.count({
      where: {
        date: { gte: day.gte, lte: day.lte },
        status: { in: ['pending', 'confirmed'] },
        ...outletFilter,
      },
    }),
    prisma.deliveryAssignment.count({
      where: {
        status: { in: ['pending', 'accepted', 'dispatched'] },
        order: { status: { not: 'CANCELLED' }, ...outletFilter },
      },
    }),
    prisma.orderCancellationRequest.count({
      where: { status: 'pending', ...outletFilter },
    }),
    getActiveBalances(outletId ?? null),
    prisma.order.findMany({
      where: { ...outletFilter, ...onlyCompleted, createdAt: { gte: sixtyDaysAgo, lte: day.lte } },
      select: { total: true, createdAt: true },
    }),
  ]);

  const liveStatusBy = Object.fromEntries(liveStatusRows.map((r) => [r.status, r._count._all]));
  const liveStatus = {
    pending: liveStatusBy.PENDING ?? 0,
    preparing: liveStatusBy.PREPARING ?? 0,
    ready: liveStatusBy.READY ?? 0,
  };

  const tables = tableStatusRows.reduce<Record<string, number>>((acc, r) => {
    acc[r.status] = r._count._all;
    return acc;
  }, { occupied: 0, available: 0 });

  const lowStockCount = warehouseStockRows.filter((s) => isLowStock(Number(s.currentStock), Number(s.lowStockLevel))).length;

  const attendanceBy = Object.fromEntries(attendanceRows.map((r) => [r.status, r._count._all]));
  const attendanceToday = {
    present: attendanceBy.present ?? 0,
    late: attendanceBy.late ?? 0,
    absent: attendanceBy.absent ?? 0,
  };

  const cashHub = {
    totalUnsettled: Math.round(cashHubBalances.reduce((s, b) => s + b.totalExpected, 0)),
    staffCount: cashHubBalances.length,
  };

  const perfLabels = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const perfTotals = [0, 0, 0, 0, 0, 0, 0];
  const perfCounts = [0, 0, 0, 0, 0, 0, 0];
  for (const o of perfOrders) {
    const idx = (new Date(o.createdAt).getUTCDay() + 6) % 7;
    perfTotals[idx] += Number(o.total);
    perfCounts[idx] += 1;
  }
  const dayOfWeekPerformance = perfLabels.map((label, i) => ({
    label,
    orderCount: perfCounts[i],
    avgSales: perfCounts[i] > 0 ? Math.round(perfTotals[i] / perfCounts[i]) : 0,
  }));

  res.json(ApiResponse.success({
    branchName: settings?.restaurantName ?? 'Ovenisto',
    scope: outletId,
    today: {
      totalSales: todayTotalSales,
      totalOrders: todayOrders.length,
      channels,
      online: { sales: Math.round(onlineSales), orders: onlineOrders },
      offline: { sales: Math.round(offlineSales), orders: offlineOrders },
      liveStatus,
    },
    month: {
      grossSale: Math.round(grossSale),
      discounts: Math.round(discounts),
      revenue: Math.round(revenue),
      expenses: Math.round(expenses),
      foodLoss: Math.round(foodLoss),
      netProfit: Math.round(netProfit),
      paymentBreakdown,
      growthOnlinePct: growthPct(monthOnline, lastOnline),
      growthOfflinePct: growthPct(monthOffline, lastOffline),
      overallGrowthPct: growthPct(revenue, lastTotal),
    },
    daywiseSales,
    payable,
    receivable,
    topItems,
    topCustomers: topCustomersMapped,
    tables,
    lowStockCount,
    pendingPurchaseRequests,
    pendingDemands,
    attendanceToday,
    pendingLeaveRequests,
    reservationsToday,
    deliveryActive,
    pendingCancellations,
    cashHub,
    peakHours,
    orderTypeTrend,
    customerActivity,
    dayOfWeekPerformance,
  }));
});

/** GET /api/reports/sales-by-channel */
export const getSalesByChannel = asyncHandler(async (req: Request, res: Response) => {
  // ── 1. Parse required date range ──────────────────────────────────────────
  const from = req.query.from as string | undefined;
  const to   = req.query.to   as string | undefined;
  const { gte, lte } = parseDateRange(from, to);

  // ── 2. Parse optional time-of-day window ──────────────────────────────────
  const fromMin = parseTimeOfDay(req.query.fromTime as string | undefined);
  const toMin   = parseTimeOfDay(req.query.toTime   as string | undefined);

  // ── 3. Resolve outlet scope from X-Outlet-Id header (never a query param) ─
  const outletId = resolveOutletScope(req) ?? undefined;

  // ── 4. Fetch completed, cash-approved orders with their items ─────────────
  const baseWhere = buildOrderWhere(gte, lte, outletId);
  const orders = await prisma.order.findMany({
    where: {
      ...baseWhere,
      status:       COMPLETED as never,
      cashApproved: true,
    },
    select: {
      type:      true,
      total:     true,
      createdAt: true,
      items: {
        select: {
          menuItemId: true,
          variantId:  true,
          qty:        true,
        },
      },
    },
  });

  // ── 5. Apply optional time-of-day filter in JS ────────────────────────────
  const filtered = orders.filter((o) => isWithinTimeOfDay(o.createdAt, fromMin, toMin));

  // ── 6. Bucket into exactly three channels; all other order types excluded ─
  const buckets: Record<'dineIn' | 'takeaway' | 'delivery', typeof filtered> = {
    dineIn:   [],
    takeaway: [],
    delivery: [],
  };
  for (const o of filtered) {
    const display = displayOrderType(String(o.type));
    // Self Order is table-based dine-in ordering by nature -- merged into Dine In here to
    // match the Sales & Orders page's identical rule (order.controller.ts's getOrders,
    // type=Dine In also matches SELF_ORDER). Keep the two in sync.
    if (display === 'Dine In' || display === 'Self Order') buckets.dineIn.push(o);
    else if (display === 'Take Away')                      buckets.takeaway.push(o);
    else if (display === 'Delivery')                       buckets.delivery.push(o);
    // Online / Foodpanda / Walk-in: intentionally excluded from this endpoint
  }

  // ── 7. Load COGS data once across all three channels ──────────────────────
  const allBucketedOrders = [...buckets.dineIn, ...buckets.takeaway, ...buckets.delivery];
  const distinctMenuItemIds = [
    ...new Set(
      allBucketedOrders
        .flatMap((o) => o.items.map((i) => i.menuItemId))
        .filter((x): x is string => !!x)
    ),
  ];

  let recipesForCogs: CogsRecipe[] = [];
  let priceById = new Map<string, number>();

  if (distinctMenuItemIds.length > 0) {
    const rawRecipes = await prisma.foodRecipe.findMany({
      where: { menuItemId: { in: distinctMenuItemIds } },
      select: { menuItemId: true, variantId: true, ingredientId: true, qtyPerUnit: true },
    });
    const distinctIngredientIds = [
      ...new Set(
        rawRecipes.map((r) => r.ingredientId).filter((id): id is string => id !== null)
      ),
    ];
    const ingredients = await prisma.ingredient.findMany({
      where: { id: { in: distinctIngredientIds } },
      select: { id: true, purchasePrice: true },
    });
    priceById = new Map(ingredients.map((i) => [i.id, Number(i.purchasePrice ?? 0)]));
    recipesForCogs = rawRecipes
      .filter((r): r is typeof r & { ingredientId: string } => r.ingredientId !== null)
      .map((r) => ({
        menuItemId:   r.menuItemId,
        variantId:    r.variantId,
        ingredientId: r.ingredientId,
        qtyPerUnit:   Number(r.qtyPerUnit),
      }));
  }

  // ── 8. Compute per-channel figures (reuse recipes/priceById for all three) ─
  const computeChannel = (bucket: typeof filtered) => {
    const items: CogsItem[] = bucket.flatMap((o) =>
      o.items.map((i) => ({
        menuItemId: i.menuItemId ?? '',
        variantId:  i.variantId ?? null,
        qty:        i.qty,
      }))
    );
    const sale   = Math.round(bucket.reduce((s, o) => s + Number(o.total), 0));
    const cost   = computeCogs(items, recipesForCogs, priceById);
    const profit = sale - cost;
    return { sale, cost, profit, orders: bucket.length };
  };

  const dineIn   = computeChannel(buckets.dineIn);
  const takeaway = computeChannel(buckets.takeaway);
  const delivery = computeChannel(buckets.delivery);

  // ── 9. Combined row sums only the three named channels ────────────────────
  const combinedSale   = dineIn.sale   + takeaway.sale   + delivery.sale;
  const combinedCost   = dineIn.cost   + takeaway.cost   + delivery.cost;
  const combinedProfit = dineIn.profit + takeaway.profit + delivery.profit;
  const combinedOrders = dineIn.orders + takeaway.orders + delivery.orders;
  const marginPct      = combinedSale > 0 ? Math.round((combinedProfit / combinedSale) * 100) : 0;

  res.json(
    ApiResponse.success({
      from:     from!,
      to:       to!,
      fromTime: fromMin !== null ? (req.query.fromTime as string) : null,
      toTime:   toMin   !== null ? (req.query.toTime   as string) : null,
      channels: { dineIn, takeaway, delivery },
      combined: {
        sale:      combinedSale,
        cost:      combinedCost,
        profit:    combinedProfit,
        orders:    combinedOrders,
        marginPct,
      },
    })
  );
});

/**
 * GET /api/reports/sales-by-category
 *
 * Sale / Cost / Profit / Margin for every food category, over the same completed + cash-approved
 * order set as getSalesByChannel (date range on createdAt, optional PKT time-of-day) — but across
 * ALL channels, not just Dine In / Take Away / Delivery, because the question here is total
 * food-category performance. Backs the Dashboard's "Sales by Category" section.
 *
 * A category figure is inherently LINE-level (the Pizza lines' revenue and COGS), unlike
 * getSalesByChannel where a whole order sits in one channel. So each order's final `total` is
 * split across its lines by gross-value share (splitOrderTotalByLine) and each slice is filed
 * under that line's menu-item category; cost is the real per-line COGS. Cancelled lines
 * (OrderItem.status !== 'active') are excluded from both the split and the buckets — a
 * deliberate, more-correct difference from getSalesByChannel, which computes COGS over every
 * item row. A line whose menu item has no category (or a deleted one) → "Uncategorised".
 */
export const getSalesByCategory = asyncHandler(async (req: Request, res: Response) => {
  const from = req.query.from as string | undefined;
  const to   = req.query.to   as string | undefined;
  const { gte, lte } = parseDateRange(from, to);

  const fromMin = parseTimeOfDay(req.query.fromTime as string | undefined);
  const toMin   = parseTimeOfDay(req.query.toTime   as string | undefined);

  const outletId = resolveOutletScope(req) ?? undefined;

  const baseWhere = buildOrderWhere(gte, lte, outletId);
  const orders = await prisma.order.findMany({
    where: { ...baseWhere, status: COMPLETED as never, cashApproved: true },
    select: {
      id:        true,
      total:     true,
      createdAt: true,
      items: {
        where:  { status: 'active' },
        select: {
          menuItemId: true,
          variantId:  true,
          qty:        true,
          price:      true,
          discount:   true,
          menuItem:   { select: { category: { select: { name: true } } } },
        },
      },
    },
  });

  const filtered = orders.filter((o) => isWithinTimeOfDay(o.createdAt, fromMin, toMin));

  // ── COGS inputs, loaded once across every line ────────────────────────────
  const menuItemIds = [
    ...new Set(
      filtered.flatMap((o) => o.items.map((i) => i.menuItemId)).filter((x): x is string => !!x)
    ),
  ];
  let recipesForCogs: CogsRecipe[] = [];
  let priceById = new Map<string, number>();
  if (menuItemIds.length > 0) {
    const rawRecipes = await prisma.foodRecipe.findMany({
      where: { menuItemId: { in: menuItemIds } },
      select: { menuItemId: true, variantId: true, ingredientId: true, qtyPerUnit: true },
    });
    const ingredientIds = [
      ...new Set(rawRecipes.map((r) => r.ingredientId).filter((id): id is string => id !== null)),
    ];
    const ingredients = await prisma.ingredient.findMany({
      where: { id: { in: ingredientIds } },
      select: { id: true, purchasePrice: true },
    });
    priceById = new Map(ingredients.map((i) => [i.id, Number(i.purchasePrice ?? 0)]));
    recipesForCogs = rawRecipes
      .filter((r): r is typeof r & { ingredientId: string } => r.ingredientId !== null)
      .map((r) => ({
        menuItemId:   r.menuItemId,
        variantId:    r.variantId,
        ingredientId: r.ingredientId,
        qtyPerUnit:   Number(r.qtyPerUnit),
      }));
  }

  // ── Bucket every line's revenue slice + real COGS by category ─────────────
  const UNCATEGORISED = 'Uncategorised';
  interface Bucket { name: string; sale: number; cost: number; orderIds: Set<string>; }
  const buckets = new Map<string, Bucket>();
  const bucketFor = (name: string): Bucket => {
    let b = buckets.get(name);
    if (!b) { b = { name, sale: 0, cost: 0, orderIds: new Set() }; buckets.set(name, b); }
    return b;
  };

  let combinedSale = 0;
  let combinedCost = 0;
  const combinedOrderIds = new Set<string>();

  for (const o of filtered) {
    if (o.items.length === 0) continue;
    const grosses = o.items.map((i) => Number(i.price) * i.qty - Number(i.discount ?? 0));
    const saleShares = splitOrderTotalByLine(Number(o.total), grosses);
    o.items.forEach((i, idx) => {
      const name = i.menuItem?.category?.name ?? UNCATEGORISED;
      const lineSale = saleShares[idx] ?? 0;
      const lineCost = computeCogs(
        [{ menuItemId: i.menuItemId ?? '', variantId: i.variantId ?? null, qty: i.qty }],
        recipesForCogs, priceById,
      );
      const b = bucketFor(name);
      b.sale += lineSale;
      b.cost += lineCost;
      b.orderIds.add(o.id);
      combinedSale += lineSale;
      combinedCost += lineCost;
    });
    combinedOrderIds.add(o.id);
  }

  // Zero-fill: every ACTIVE FoodCategory shows even with no sales this period (a category with
  // nothing sold is a signal, not noise). The "Uncategorised" pseudo-bucket is NOT a real
  // category, so it only appears when it actually has activity.
  const activeCats = await prisma.foodCategory.findMany({
    where: { status: 'active' },
    select: { name: true, displayOrder: true },
  });
  const displayOrderByName = new Map(activeCats.map((c) => [c.name, c.displayOrder]));
  for (const c of activeCats) {
    if (!buckets.has(c.name)) bucketFor(c.name); // creates a { sale:0, cost:0, orderIds:∅ } bucket
  }

  const categories = [...buckets.values()]
    .map((b) => {
      const sale = Math.round(b.sale);
      const cost = Math.round(b.cost);
      const profit = sale - cost;
      return {
        name:      b.name,
        sale,
        cost,
        profit,
        orders:    b.orderIds.size,
        marginPct: sale > 0 ? Math.round((profit / sale) * 100) : 0,
      };
    })
    // Categories with sales first (by sale desc); the zero-activity ones after, in their
    // configured display order.
    .sort((a, b) => {
      const aHas = a.sale > 0 ? 1 : 0;
      const bHas = b.sale > 0 ? 1 : 0;
      if (aHas !== bHas) return bHas - aHas;
      if (b.sale !== a.sale) return b.sale - a.sale;
      return (displayOrderByName.get(a.name) ?? 999) - (displayOrderByName.get(b.name) ?? 999);
    });

  const cSale = Math.round(combinedSale);
  const cCost = Math.round(combinedCost);
  const cProfit = cSale - cCost;

  res.json(
    ApiResponse.success({
      from:     from!,
      to:       to!,
      fromTime: fromMin !== null ? (req.query.fromTime as string) : null,
      toTime:   toMin   !== null ? (req.query.toTime   as string) : null,
      categories,
      combined: {
        sale:      cSale,
        cost:      cCost,
        profit:    cProfit,
        orders:    combinedOrderIds.size,
        marginPct: cSale > 0 ? Math.round((cProfit / cSale) * 100) : 0,
      },
    })
  );
});

/**
 * GET /api/reports/sales-by-payment-method
 *
 * Amount collected / order count / % share per payment method, over the same completed +
 * `cashApproved` order set as getSalesByChannel (date range on createdAt, optional PKT
 * time-of-day), all channels. Backs the Dashboard's "Sales by Payment Method" section.
 *
 * Cost/Profit is meaningless per payment method, so this endpoint returns amounts only.
 * `Order.paymentMethod` is a free-text string that can hold a split ("Cash: Rs.900, JazzCash:
 * Rs.779") or an advance/COD shape — `groupPaymentsWithCounts` (the same canonical parser
 * getDashboard's paymentBreakdown uses) credits each method its own parsed amount and counts it
 * toward each method's order tally, so `Σ methods[].orders` can exceed `combined.orders`
 * (distinct orders). `cashAmount` is the "Cash" bucket; `digitalAmount` is everything else.
 */
export const getSalesByPaymentMethod = asyncHandler(async (req: Request, res: Response) => {
  const from = req.query.from as string | undefined;
  const to   = req.query.to   as string | undefined;
  const { gte, lte } = parseDateRange(from, to);

  const fromMin = parseTimeOfDay(req.query.fromTime as string | undefined);
  const toMin   = parseTimeOfDay(req.query.toTime   as string | undefined);

  const outletId = resolveOutletScope(req) ?? undefined;

  const baseWhere = buildOrderWhere(gte, lte, outletId);
  const orders = await prisma.order.findMany({
    where: { ...baseWhere, status: COMPLETED as never, cashApproved: true },
    select: { paymentMethod: true, total: true, createdAt: true },
  });

  const filtered = orders.filter((o) => isWithinTimeOfDay(o.createdAt, fromMin, toMin));

  const byMethod = groupPaymentsWithCounts(
    filtered.map((o) => ({ method: o.paymentMethod, amount: Number(o.total) })),
  );

  const totalAmount = byMethod.reduce((s, m) => s + m.amount, 0);
  const cashAmount = byMethod.find((m) => m.method.toLowerCase() === 'cash')?.amount ?? 0;
  const digitalAmount = totalAmount - cashAmount;

  // Zero-fill: every configured payment method shows even with nothing collected this period
  // (Cash is always included). Matched case-insensitively against what the parser returned so a
  // configured "Credit Card" and a parsed "credit card" don't become two rows.
  const settingsRow = await prisma.settings.findFirst({ select: { paymentMethods: true } });
  const configured = (settingsRow?.paymentMethods && settingsRow.paymentMethods.length > 0)
    ? settingsRow.paymentMethods
    : ['Cash', 'Credit Card', 'Account', 'JazzCash', 'EasyPaisa'];
  const wantedMethods = [...new Set(['Cash', ...configured])];
  const seenLower = new Set(byMethod.map((m) => m.method.toLowerCase()));
  const zeroFilled = [
    ...byMethod,
    ...wantedMethods
      .filter((w) => !seenLower.has(w.toLowerCase()))
      .map((w) => ({ method: w, amount: 0, orders: 0 })),
  ];

  const methods = zeroFilled
    .map((m) => ({
      method:   m.method,
      amount:   m.amount,
      orders:   m.orders,
      sharePct: totalAmount > 0 ? Math.round((m.amount / totalAmount) * 100) : 0,
    }))
    // amount desc — the zero-filled methods sink to the bottom, keeping configured order (stable sort)
    .sort((a, b) => b.amount - a.amount);

  res.json(
    ApiResponse.success({
      from:     from!,
      to:       to!,
      fromTime: fromMin !== null ? (req.query.fromTime as string) : null,
      toTime:   toMin   !== null ? (req.query.toTime   as string) : null,
      methods,
      combined: {
        amount:        totalAmount,
        orders:        filtered.length,
        cashAmount,
        digitalAmount,
        cashSharePct:  totalAmount > 0 ? Math.round((cashAmount / totalAmount) * 100) : 0,
      },
    })
  );
});

/**
 * GET /api/reports/top-items
 *
 * Best- and worst-performing menu ITEMS by profit, over the same completed + `cashApproved`
 * order set as getSalesByChannel (date range on createdAt, optional PKT time-of-day), all
 * channels. Backs the Dashboard's "Top & Bottom Items" section.
 *
 * Line-level: each order's final `total` is split across its active lines by gross-value share
 * (splitOrderTotalByLine — same proration as getSalesByCategory, keeping Sale reconcilable with
 * Order.total), cost is the real per-line COGS (computeCogs). Rows are aggregated by
 * `menuItemId` — every size/variant of an item merges into one row (name from the live
 * FoodMenuItem, falling back to the order line's stored name for a since-deleted item). A line
 * from a deal counts toward its item with the deal-allocated revenue. Lines with no menuItemId
 * (manual/custom entries) are skipped. `topItems` = top 10 by profit desc; `bottomItems` =
 * bottom 10 by profit asc (loss-makers first); both drawn from the same aggregated set, so with
 * ≤ 20 distinct items sold they overlap — the frontend hides the bottom table when
 * totalItems ≤ 10.
 */
export const getTopItems = asyncHandler(async (req: Request, res: Response) => {
  const from = req.query.from as string | undefined;
  const to   = req.query.to   as string | undefined;
  const { gte, lte } = parseDateRange(from, to);

  const fromMin = parseTimeOfDay(req.query.fromTime as string | undefined);
  const toMin   = parseTimeOfDay(req.query.toTime   as string | undefined);

  const outletId = resolveOutletScope(req) ?? undefined;

  const baseWhere = buildOrderWhere(gte, lte, outletId);
  const orders = await prisma.order.findMany({
    where: { ...baseWhere, status: COMPLETED as never, cashApproved: true },
    select: {
      total:     true,
      createdAt: true,
      items: {
        where:  { status: 'active' },
        select: {
          menuItemId: true,
          variantId:  true,
          qty:        true,
          price:      true,
          discount:   true,
          name:       true,
          menuItem:   { select: { name: true } },
        },
      },
    },
  });

  const filtered = orders.filter((o) => isWithinTimeOfDay(o.createdAt, fromMin, toMin));

  // COGS inputs, once across every line.
  const menuItemIds = [
    ...new Set(
      filtered.flatMap((o) => o.items.map((i) => i.menuItemId)).filter((x): x is string => !!x)
    ),
  ];
  let recipesForCogs: CogsRecipe[] = [];
  let priceById = new Map<string, number>();
  if (menuItemIds.length > 0) {
    const rawRecipes = await prisma.foodRecipe.findMany({
      where: { menuItemId: { in: menuItemIds } },
      select: { menuItemId: true, variantId: true, ingredientId: true, qtyPerUnit: true },
    });
    const ingredientIds = [
      ...new Set(rawRecipes.map((r) => r.ingredientId).filter((id): id is string => id !== null)),
    ];
    const ingredients = await prisma.ingredient.findMany({
      where: { id: { in: ingredientIds } },
      select: { id: true, purchasePrice: true },
    });
    priceById = new Map(ingredients.map((i) => [i.id, Number(i.purchasePrice ?? 0)]));
    recipesForCogs = rawRecipes
      .filter((r): r is typeof r & { ingredientId: string } => r.ingredientId !== null)
      .map((r) => ({
        menuItemId:   r.menuItemId,
        variantId:    r.variantId,
        ingredientId: r.ingredientId,
        qtyPerUnit:   Number(r.qtyPerUnit),
      }));
  }

  interface ItemAgg { menuItemId: string; name: string; qty: number; sale: number; cost: number; }
  const byItem = new Map<string, ItemAgg>();

  for (const o of filtered) {
    if (o.items.length === 0) continue;
    const grosses = o.items.map((i) => Number(i.price) * i.qty - Number(i.discount ?? 0));
    const saleShares = splitOrderTotalByLine(Number(o.total), grosses);
    o.items.forEach((i, idx) => {
      if (!i.menuItemId) return; // manual/custom line — no item to attribute to
      let agg = byItem.get(i.menuItemId);
      if (!agg) {
        agg = { menuItemId: i.menuItemId, name: i.menuItem?.name ?? i.name, qty: 0, sale: 0, cost: 0 };
        byItem.set(i.menuItemId, agg);
      }
      agg.qty += i.qty;
      agg.sale += saleShares[idx] ?? 0;
      agg.cost += computeCogs(
        [{ menuItemId: i.menuItemId, variantId: i.variantId ?? null, qty: i.qty }],
        recipesForCogs, priceById,
      );
    });
  }

  const allItems = [...byItem.values()].map((a) => {
    const sale = Math.round(a.sale);
    const cost = Math.round(a.cost);
    const profit = sale - cost;
    return {
      menuItemId: a.menuItemId,
      name:       a.name,
      qty:        a.qty,
      sale,
      cost,
      profit,
      marginPct:  sale > 0 ? Math.round((profit / sale) * 100) : 0,
    };
  });

  const N = 10;
  const topItems = [...allItems].sort((a, b) => b.profit - a.profit).slice(0, N);
  const bottomItems = [...allItems].sort((a, b) => a.profit - b.profit).slice(0, N);

  res.json(
    ApiResponse.success({
      from:       from!,
      to:         to!,
      fromTime:   fromMin !== null ? (req.query.fromTime as string) : null,
      toTime:     toMin   !== null ? (req.query.toTime   as string) : null,
      topItems,
      bottomItems,
      totalItems: allItems.length,
    })
  );
});

/**
 * GET /api/reports/net-profit
 *
 * The full bottom line for the Dashboard's "Net Profit" section, over one date range (no
 * time-of-day — expenses and waste aren't hourly), outlet-scoped:
 *
 *   Net Profit = Revenue − COGS − Food Loss − Expenses
 *
 * This is the first place in the app that subtracts ALL FOUR. getPnlReport does
 * Revenue − COGS − Expenses (no waste); getDashboard's financial-overview netProfit does
 * Revenue − Expenses − Food Loss (no COGS). Both are kept as-is; this endpoint is the correct one.
 *   - Revenue   = Σ Order.total  (COMPLETED + cashApproved)
 *   - COGS      = computeCogs over every sold line's recipe ingredients (same engine as P&L)
 *   - Food Loss = Σ WasteRecord.cost  (expired / damaged / wasted stock — the Stock
 *                 Adjustments/Waste page; StockAdjustment type=correction rows are NOT waste)
 *   - Expenses  = Σ Expense.amount  (rent / salary / utilities — the Expenses page)
 *
 * `purchases` (Σ Purchase.total for received purchases in range) is returned for CONTEXT only —
 * it is NOT subtracted. Buying stock is inventory (an asset); it becomes a cost as it is
 * consumed (COGS) or wasted (Food Loss), not when it is bought. Shown as a separate tile so the
 * user can see stock-buying activity alongside the bottom line.
 */
export const getNetProfit = asyncHandler(async (req: Request, res: Response) => {
  const { gte, lte, outletId } = getParams(req);
  const completedWhere = { ...buildOrderWhere(gte, lte, outletId), status: COMPLETED as never, cashApproved: true };

  const [completed, expenseRows, wasteRows, purchaseRows] = await Promise.all([
    prisma.order.findMany({
      where: completedWhere,
      select: { total: true, items: { select: { menuItemId: true, variantId: true, qty: true } } },
    }),
    prisma.expense.findMany({
      where: { ...(outletId ? { outletId } : {}), date: { gte, lte } },
      select: { amount: true, category: true },
    }),
    prisma.wasteRecord.findMany({
      where: { ...(outletId ? { outletId } : {}), date: { gte, lte } },
      select: { cost: true, reason: true },
    }),
    prisma.purchase.findMany({
      where: { ...(outletId ? { outletId } : {}), date: { gte, lte }, status: { not: 'pending' } },
      select: { total: true },
    }),
  ]);

  const revenue = completed.reduce((s, o) => s + Number(o.total), 0);

  // COGS — same inline load pattern getPnlReport / getSalesByChannel use (kept inline so
  // reports.helpers.ts stays DB-free for its pure unit tests).
  const menuItemIds = [
    ...new Set(completed.flatMap((o) => o.items.map((i) => i.menuItemId)).filter((x): x is string => !!x)),
  ];
  let cogs = 0;
  if (menuItemIds.length > 0) {
    const recipes = await prisma.foodRecipe.findMany({
      where: { menuItemId: { in: menuItemIds } },
      select: { menuItemId: true, variantId: true, ingredientId: true, qtyPerUnit: true },
    });
    const ingredientIds = [...new Set(recipes.map((r) => r.ingredientId).filter((id): id is string => id !== null))];
    const ingredients = await prisma.ingredient.findMany({
      where: { id: { in: ingredientIds } },
      select: { id: true, purchasePrice: true },
    });
    const priceById = new Map(ingredients.map((i) => [i.id, Number(i.purchasePrice ?? 0)]));
    const recipesForCogs = recipes
      .filter((r): r is typeof r & { ingredientId: string } => r.ingredientId !== null)
      .map((r) => ({
        menuItemId: r.menuItemId,
        variantId: r.variantId,
        ingredientId: r.ingredientId,
        qtyPerUnit: Number(r.qtyPerUnit),
      }));
    cogs = computeCogs(completed.flatMap((o) => o.items), recipesForCogs, priceById);
  }

  const expenses = Math.round(expenseRows.reduce((s, e) => s + Number(e.amount), 0));
  const foodLoss = Math.round(wasteRows.reduce((s, w) => s + Number(w.cost ?? 0), 0));
  const purchases = Math.round(purchaseRows.reduce((s, p) => s + Number(p.total ?? 0), 0));

  const expCatMap = new Map<string, number>();
  for (const e of expenseRows) {
    const name = e.category ?? 'Uncategorized';
    expCatMap.set(name, (expCatMap.get(name) ?? 0) + Number(e.amount));
  }
  const expenseByCategory = [...expCatMap.entries()]
    .map(([name, value]) => ({ name, value: Math.round(value) }))
    .filter((r) => r.value > 0)
    .sort((a, b) => b.value - a.value);

  const wasteReasonMap = new Map<string, number>();
  for (const w of wasteRows) {
    const name = w.reason?.trim() || 'Unspecified';
    wasteReasonMap.set(name, (wasteReasonMap.get(name) ?? 0) + Number(w.cost ?? 0));
  }
  const wasteByReason = [...wasteReasonMap.entries()]
    .map(([name, value]) => ({ name, value: Math.round(value) }))
    .filter((r) => r.value > 0)
    .sort((a, b) => b.value - a.value);

  const rev = Math.round(revenue);
  const grossProfit = rev - cogs;
  const netProfit = grossProfit - foodLoss - expenses;

  res.json(
    ApiResponse.success({
      from: req.query.from as string,
      to: req.query.to as string,
      revenue: rev,
      cogs,
      grossProfit,
      foodLoss,
      expenses,
      netProfit,
      /** Context only — NOT subtracted from netProfit. See the handler doc-comment. */
      purchases,
      grossMarginPct: rev > 0 ? Math.round((grossProfit / rev) * 100) : 0,
      netMarginPct: rev > 0 ? Math.round((netProfit / rev) * 100) : 0,
      expenseByCategory,
      wasteByReason,
    })
  );
});

/**
 * GET /api/reports/deals-performance
 *
 * Redemption count + revenue (+ cost/profit where meaningful) per Deal, over one date range
 * (no time-of-day, same choice as Net Profit — deal usage isn't hourly-sensitive), outlet-scoped
 * via the underlying orders (Deal itself has no outletId — it's a chain-wide catalog overlay,
 * see "Outlet targeting" in the Deals section of CLAUDE.md).
 *
 * Two disjoint sources merge into one table:
 *   - Line-item deals (COMBO/OPTION_COMBO/PERCENTAGE/BUY_X_GET_Y) tag OrderItem.dealId/
 *     dealLineId — one dealLineId = one redemption. Revenue is that line's proportional share of
 *     Order.total (splitOrderTotalByLine, same method Top & Bottom Items uses, computed over ALL
 *     of the order's items so shares still sum to Order.total when an order mixes deal and
 *     non-deal lines); Cost via computeCogs. These rows carry Cost/Profit/Margin.
 *   - Order-level deals (PROMO_CODE/MIN_SPEND) tag Order.appliedDealId — one such order = one
 *     redemption, Revenue = the whole Order.total (not prorated, it's genuinely order-level). No
 *     Cost/Profit: an order-level discount isn't tied to specific menu items, and the exact
 *     discount amount isn't cleanly recoverable either — Order.discount merges manual + deal
 *     discount into one figure app-wide (see the Deals "money contract" in CLAUDE.md) — so these
 *     rows are revenue/usage only, never a savings figure. `appliedDealCode` set = PROMO_CODE,
 *     null = MIN_SPEND (the same switch resolveOrderDiscount uses).
 *
 * `Deal.type` isn't stored on Order/OrderItem, so it's looked up separately for line-deal rows
 * only (order-level rows already know their type from appliedDealCode). dealId/appliedDealId are
 * plain strings, never a formal FK — a since-deleted deal still reports correctly by its stored
 * name, just falls back to a generic type label since its live type can no longer be read.
 */
export const getDealsPerformance = asyncHandler(async (req: Request, res: Response) => {
  const { gte, lte, outletId } = getParams(req);
  const completedWhere = { ...buildOrderWhere(gte, lte, outletId), status: COMPLETED as never, cashApproved: true };

  const orders = await prisma.order.findMany({
    where: completedWhere,
    select: {
      total: true,
      subtotal: true,
      type: true,
      appliedDealId: true,
      appliedDealName: true,
      appliedDealCode: true,
      items: {
        where: { status: 'active' },
        select: {
          menuItemId: true, variantId: true, qty: true, price: true, discount: true,
          dealId: true, dealName: true, dealLineId: true,
        },
      },
    },
  });

  // COGS inputs, once across every line (same inline pattern getTopItems/getNetProfit use —
  // kept inline so reports.helpers.ts stays DB-free for its pure unit tests).
  const menuItemIds = [
    ...new Set(orders.flatMap((o) => o.items.map((i) => i.menuItemId)).filter((x): x is string => !!x)),
  ];
  let recipesForCogs: CogsRecipe[] = [];
  let priceById = new Map<string, number>();
  if (menuItemIds.length > 0) {
    const rawRecipes = await prisma.foodRecipe.findMany({
      where: { menuItemId: { in: menuItemIds } },
      select: { menuItemId: true, variantId: true, ingredientId: true, qtyPerUnit: true },
    });
    const ingredientIds = [...new Set(rawRecipes.map((r) => r.ingredientId).filter((id): id is string => id !== null))];
    const ingredients = await prisma.ingredient.findMany({
      where: { id: { in: ingredientIds } },
      select: { id: true, purchasePrice: true },
    });
    priceById = new Map(ingredients.map((i) => [i.id, Number(i.purchasePrice ?? 0)]));
    recipesForCogs = rawRecipes
      .filter((r): r is typeof r & { ingredientId: string } => r.ingredientId !== null)
      .map((r) => ({ menuItemId: r.menuItemId, variantId: r.variantId, ingredientId: r.ingredientId, qtyPerUnit: Number(r.qtyPerUnit) }));
  }

  interface DealAgg {
    dealId: string; name: string; type: string | null;
    lineRedemptions: Set<string>; orderRedemptions: number;
    revenue: number; cost: number; discount: number; isLineDeal: boolean;
  }
  const byDeal = new Map<string, DealAgg>();
  const getAgg = (dealId: string, name: string): DealAgg => {
    let agg = byDeal.get(dealId);
    if (!agg) {
      agg = { dealId, name, type: null, lineRedemptions: new Set(), orderRedemptions: 0, revenue: 0, cost: 0, discount: 0, isLineDeal: false };
      byDeal.set(dealId, agg);
    }
    return agg;
  };
  // Orders whose deal is order-level (Promo Code/Min Spend) — their discount amount can't be
  // read off Order.discount (it may also include a stacked manual discount), so it's recomputed
  // below via computeOrderDiscount against each order's own subtotal/type, grouped per deal.
  const orderDealOrders = new Map<string, { subtotal: number; type: string }[]>();

  for (const o of orders) {
    if (o.items.length > 0) {
      const grosses = o.items.map((i) => Number(i.price) * i.qty - Number(i.discount ?? 0));
      const saleShares = splitOrderTotalByLine(Number(o.total), grosses);
      o.items.forEach((i, idx) => {
        if (!i.dealId || !i.dealLineId) return;
        const agg = getAgg(i.dealId, i.dealName ?? 'Deal');
        agg.isLineDeal = true;
        agg.lineRedemptions.add(i.dealLineId as string);
        agg.revenue += saleShares[idx] ?? 0;
        agg.discount += Number(i.discount ?? 0);
        if (i.menuItemId) {
          agg.cost += computeCogs(
            [{ menuItemId: i.menuItemId, variantId: i.variantId ?? null, qty: i.qty }],
            recipesForCogs, priceById,
          );
        }
      });
    }
    if (o.appliedDealId) {
      const agg = getAgg(o.appliedDealId, o.appliedDealName ?? 'Deal');
      agg.type = o.appliedDealCode ? 'PROMO_CODE' : 'MIN_SPEND';
      agg.orderRedemptions += 1;
      agg.revenue += Number(o.total);
      const list = orderDealOrders.get(o.appliedDealId) ?? [];
      list.push({ subtotal: Number(o.subtotal), type: o.type as string });
      orderDealOrders.set(o.appliedDealId, list);
    }
  }

  const lineDealIds = [...byDeal.values()].filter((a) => a.isLineDeal).map((a) => a.dealId);
  if (lineDealIds.length > 0) {
    const liveDeals = await prisma.deal.findMany({ where: { id: { in: lineDealIds } }, select: { id: true, type: true } });
    const typeById = new Map(liveDeals.map((d) => [d.id, d.type as string]));
    for (const agg of byDeal.values()) {
      if (agg.isLineDeal) agg.type = typeById.get(agg.dealId) ?? agg.type;
    }
  }

  // Order-level deal discount: recomputed via the SAME computeOrderDiscount function
  // resolveOrderDiscount uses at checkout, against each redeeming order's own subtotal/type —
  // NOT read off Order.discount, which stays possibly a manual+deal sum for any order that
  // predates the single-discount-per-order rule (or one where a Min Spend/Promo Code applied
  // with no line-item deal, where manual discount can still legitimately stack alongside it).
  // Uses the DEAL'S CURRENT config (percent/flat amount) — if a deal's discount was edited after
  // some of these orders were placed, their recomputed figure reflects today's config, not
  // necessarily what was actually charged at the time.
  if (orderDealOrders.size > 0) {
    const orderDealIds = [...orderDealOrders.keys()];
    const orderDeals = await prisma.deal.findMany({ where: { id: { in: orderDealIds } } });
    for (const deal of orderDeals) {
      const agg = byDeal.get(deal.id);
      const redemptions = orderDealOrders.get(deal.id);
      if (!agg || !redemptions) continue;
      const dealForPricing = toDealForPricing(deal);
      for (const r of redemptions) {
        const outcome = computeOrderDiscount(dealForPricing, r.type, r.subtotal);
        if (outcome.valid) agg.discount += outcome.amount ?? 0;
      }
    }
  }

  const rows = [...byDeal.values()]
    .map((a) => {
      const revenue = Math.round(a.revenue);
      const cost = a.isLineDeal ? Math.round(a.cost) : null;
      const profit = cost !== null ? revenue - cost : null;
      return {
        dealId: a.dealId,
        name: a.name,
        type: a.type ?? (a.isLineDeal ? 'LINE_DEAL' : 'ORDER_DEAL'),
        redemptions: a.lineRedemptions.size + a.orderRedemptions,
        revenue,
        cost,
        profit,
        marginPct: profit !== null && revenue > 0 ? Math.round((profit / revenue) * 100) : null,
        discount: Math.round(a.discount),
      };
    })
    .sort((x, y) => y.redemptions - x.redemptions);

  const totalRedemptions = rows.reduce((s, r) => s + r.redemptions, 0);
  const totalRevenue = Math.round(rows.reduce((s, r) => s + r.revenue, 0));
  const activeDealsCount = await prisma.deal.count({ where: { isActive: true, status: 'active' } });

  res.json(
    ApiResponse.success({
      from: req.query.from as string,
      to: req.query.to as string,
      rows,
      totalRedemptions,
      totalRevenue,
      mostUsed: rows[0] ? { name: rows[0].name, redemptions: rows[0].redemptions } : null,
      activeDealsCount,
    })
  );
});

/**
 * GET /api/reports/sales-by-staff
 *
 * Orders/Sale/Cost/Profit/Margin per staff member (`Order.staffId`/`staffName`) — the Dashboard's
 * "Sales by Staff" section (7th filterable section; date range + optional PKT time-of-day, same
 * pattern as Sales By Channel — shift-based analysis benefits from the time window). Same
 * completed + cashApproved order set as every other "Sales by X" endpoint, all channels.
 * Outlet-scoped like everything else here — staff themselves are already pinned to one outlet.
 *
 * Grouped by `staffId` when present; a null `staffId` (a historical order predating staff
 * attribution, or one placed with no logged-in user) falls back to grouping by `staffName`
 * under an "Unassigned" bucket — `staffId` on that row stays `null`, so the frontend knows not to
 * offer a drill-down for it (no id to filter `/api/orders?staffId=` by).
 *
 * `source` is which ordering surface(s) that staff member's orders in this window came through
 * (`Order.orderSource`) — usually one (a Cashier's orders are "POS", a Waiter's are "Waiter"),
 * joined with " / " on the rare login that used more than one surface in the same window.
 */
export const getSalesByStaff = asyncHandler(async (req: Request, res: Response) => {
  const from = req.query.from as string | undefined;
  const to = req.query.to as string | undefined;
  const { gte, lte } = parseDateRange(from, to);
  const fromMin = parseTimeOfDay(req.query.fromTime as string | undefined);
  const toMin = parseTimeOfDay(req.query.toTime as string | undefined);
  const outletId = resolveOutletScope(req) ?? undefined;

  const baseWhere = buildOrderWhere(gte, lte, outletId);
  const orders = await prisma.order.findMany({
    where: { ...baseWhere, status: COMPLETED as never, cashApproved: true },
    select: {
      staffId: true, staffName: true, orderSource: true, total: true, createdAt: true,
      items: { select: { menuItemId: true, variantId: true, qty: true } },
    },
  });
  const filtered = orders.filter((o) => isWithinTimeOfDay(o.createdAt, fromMin, toMin));

  // COGS inputs, once across every line (same inline pattern every other "Sales by X" /
  // getTopItems / getNetProfit / getDealsPerformance endpoint uses).
  const menuItemIds = [
    ...new Set(filtered.flatMap((o) => o.items.map((i) => i.menuItemId)).filter((x): x is string => !!x)),
  ];
  let recipesForCogs: CogsRecipe[] = [];
  let priceById = new Map<string, number>();
  if (menuItemIds.length > 0) {
    const rawRecipes = await prisma.foodRecipe.findMany({
      where: { menuItemId: { in: menuItemIds } },
      select: { menuItemId: true, variantId: true, ingredientId: true, qtyPerUnit: true },
    });
    const ingredientIds = [...new Set(rawRecipes.map((r) => r.ingredientId).filter((id): id is string => id !== null))];
    const ingredients = await prisma.ingredient.findMany({
      where: { id: { in: ingredientIds } },
      select: { id: true, purchasePrice: true },
    });
    priceById = new Map(ingredients.map((i) => [i.id, Number(i.purchasePrice ?? 0)]));
    recipesForCogs = rawRecipes
      .filter((r): r is typeof r & { ingredientId: string } => r.ingredientId !== null)
      .map((r) => ({ menuItemId: r.menuItemId, variantId: r.variantId, ingredientId: r.ingredientId, qtyPerUnit: Number(r.qtyPerUnit) }));
  }

  interface StaffAgg {
    staffId: string | null; name: string;
    orders: number; sale: number; cost: number; sources: Set<string>;
  }
  const byStaff = new Map<string, StaffAgg>();
  for (const o of filtered) {
    const key = o.staffId ?? `__unassigned__:${o.staffName ?? 'Unknown'}`;
    let agg = byStaff.get(key);
    if (!agg) {
      agg = { staffId: o.staffId ?? null, name: o.staffName ?? 'Unassigned', orders: 0, sale: 0, cost: 0, sources: new Set() };
      byStaff.set(key, agg);
    }
    agg.orders += 1;
    agg.sale += Number(o.total);
    agg.cost += computeCogs(
      o.items.map((i) => ({ menuItemId: i.menuItemId ?? '', variantId: i.variantId ?? null, qty: i.qty })),
      recipesForCogs, priceById,
    );
    if (o.orderSource) agg.sources.add(o.orderSource);
  }

  const SOURCE_LABELS: Record<string, string> = {
    pos: 'POS', waiter: 'Waiter', 'self-order': 'Self-Order', website: 'Website', foodpanda: 'Foodpanda', phone: 'Phone',
  };
  const rows = [...byStaff.values()]
    .map((a) => {
      const sale = Math.round(a.sale);
      const cost = Math.round(a.cost);
      const profit = sale - cost;
      return {
        staffId: a.staffId,
        name: a.name,
        orders: a.orders,
        sale,
        cost,
        profit,
        marginPct: sale > 0 ? Math.round((profit / sale) * 100) : 0,
        source: [...a.sources].map((s) => SOURCE_LABELS[s] ?? s).join(' / ') || '—',
      };
    })
    .sort((x, y) => y.sale - x.sale);

  const totalSale = Math.round(rows.reduce((s, r) => s + r.sale, 0));
  const totalCost = Math.round(rows.reduce((s, r) => s + r.cost, 0));
  const totalProfit = totalSale - totalCost;
  const totalOrders = rows.reduce((s, r) => s + r.orders, 0);

  res.json(
    ApiResponse.success({
      from: from!,
      to: to!,
      fromTime: fromMin !== null ? (req.query.fromTime as string) : null,
      toTime: toMin !== null ? (req.query.toTime as string) : null,
      rows,
      combined: {
        sale: totalSale,
        cost: totalCost,
        profit: totalProfit,
        orders: totalOrders,
        marginPct: totalSale > 0 ? Math.round((totalProfit / totalSale) * 100) : 0,
      },
    })
  );
});

/**
 * GET /api/reports/sales-by-outlet
 *
 * Orders/Sale/Cost/Profit/Margin per Outlet, over the same completed + cashApproved order set as
 * getSalesByChannel (date range + optional PKT time-of-day), all channels — a chain-wide branch
 * comparison. Meaningful only when resolveOutletScope returns null (Super Admin viewing "All
 * Outlets") — every other role/selection is pinned to one outlet by buildOrderWhere, so this
 * endpoint just returns a single row for them; harmless, but the frontend section is gated to
 * Super Admin + outletId==="all" since a one-row "comparison" has no value.
 */
export const getSalesByOutlet = asyncHandler(async (req: Request, res: Response) => {
  const from = req.query.from as string | undefined;
  const to = req.query.to as string | undefined;
  const { gte, lte } = parseDateRange(from, to);
  const fromMin = parseTimeOfDay(req.query.fromTime as string | undefined);
  const toMin = parseTimeOfDay(req.query.toTime as string | undefined);
  const outletId = resolveOutletScope(req) ?? undefined;

  const baseWhere = buildOrderWhere(gte, lte, outletId);
  const orders = await prisma.order.findMany({
    where: { ...baseWhere, status: COMPLETED as never, cashApproved: true },
    select: {
      outletId: true, total: true, createdAt: true,
      items: { select: { menuItemId: true, variantId: true, qty: true } },
    },
  });
  const filtered = orders.filter((o) => isWithinTimeOfDay(o.createdAt, fromMin, toMin));

  const menuItemIds = [
    ...new Set(filtered.flatMap((o) => o.items.map((i) => i.menuItemId)).filter((x): x is string => !!x)),
  ];
  let recipesForCogs: CogsRecipe[] = [];
  let priceById = new Map<string, number>();
  if (menuItemIds.length > 0) {
    const rawRecipes = await prisma.foodRecipe.findMany({
      where: { menuItemId: { in: menuItemIds } },
      select: { menuItemId: true, variantId: true, ingredientId: true, qtyPerUnit: true },
    });
    const ingredientIds = [...new Set(rawRecipes.map((r) => r.ingredientId).filter((id): id is string => id !== null))];
    const ingredients = await prisma.ingredient.findMany({
      where: { id: { in: ingredientIds } },
      select: { id: true, purchasePrice: true },
    });
    priceById = new Map(ingredients.map((i) => [i.id, Number(i.purchasePrice ?? 0)]));
    recipesForCogs = rawRecipes
      .filter((r): r is typeof r & { ingredientId: string } => r.ingredientId !== null)
      .map((r) => ({ menuItemId: r.menuItemId, variantId: r.variantId, ingredientId: r.ingredientId, qtyPerUnit: Number(r.qtyPerUnit) }));
  }

  interface OutletAgg { outletId: string | null; orders: number; sale: number; cost: number; }
  const byOutlet = new Map<string, OutletAgg>();
  for (const o of filtered) {
    const key = o.outletId ?? '__none__';
    let agg = byOutlet.get(key);
    if (!agg) {
      agg = { outletId: o.outletId, orders: 0, sale: 0, cost: 0 };
      byOutlet.set(key, agg);
    }
    agg.orders += 1;
    agg.sale += Number(o.total);
    agg.cost += computeCogs(
      o.items.map((i) => ({ menuItemId: i.menuItemId ?? '', variantId: i.variantId ?? null, qty: i.qty })),
      recipesForCogs, priceById,
    );
  }

  const outletIds = [...byOutlet.values()].map((a) => a.outletId).filter((id): id is string => !!id);
  const outlets = outletIds.length > 0
    ? await prisma.outlet.findMany({ where: { id: { in: outletIds } }, select: { id: true, name: true } })
    : [];
  const nameById = new Map(outlets.map((o) => [o.id, o.name]));

  const rows = [...byOutlet.values()]
    .map((a) => {
      const sale = Math.round(a.sale);
      const cost = Math.round(a.cost);
      const profit = sale - cost;
      return {
        outletId: a.outletId,
        name: a.outletId ? (nameById.get(a.outletId) ?? 'Unknown Outlet') : 'No Outlet',
        orders: a.orders,
        sale,
        cost,
        profit,
        marginPct: sale > 0 ? Math.round((profit / sale) * 100) : 0,
      };
    })
    .sort((x, y) => y.sale - x.sale);

  const totalSale = Math.round(rows.reduce((s, r) => s + r.sale, 0));
  const totalCost = Math.round(rows.reduce((s, r) => s + r.cost, 0));
  const totalProfit = totalSale - totalCost;
  const totalOrders = rows.reduce((s, r) => s + r.orders, 0);

  res.json(
    ApiResponse.success({
      from: from!,
      to: to!,
      fromTime: fromMin !== null ? (req.query.fromTime as string) : null,
      toTime: toMin !== null ? (req.query.toTime as string) : null,
      rows,
      combined: {
        sale: totalSale,
        cost: totalCost,
        profit: totalProfit,
        orders: totalOrders,
        marginPct: totalSale > 0 ? Math.round((totalProfit / totalSale) * 100) : 0,
      },
    })
  );
});

/**
 * GET /api/reports/cancellation-requests
 *
 * Backs the Dashboard's "Cancellation Requests" section — date range only (a cancellation is a
 * discrete event, not hourly, same reasoning as Deals Performance/Net Profit). Counts/amounts
 * over `OrderCancellationRequest.createdAt` (the request's filing time, not the order's), outlet-
 * scoped. Headline counts (approved/rejected/pending) cover every request in range regardless of
 * status, but the reason/staff breakdowns and the money totals are computed over APPROVED
 * requests only — a pending or rejected request never actually refunded anything or penalised
 * anyone, so including them would overstate real loss. `responsibleUserId` is the staff member
 * marked accountable for the incident (see `cancellation-request.controller.ts`'s `approveRequest`
 * — only set/penalised on approval), not `requestedById` (whoever filed the request, often a
 * different person like a manager on the staff member's behalf).
 */
export const getCancellationRequestsReport = asyncHandler(async (req: Request, res: Response) => {
  const from = req.query.from as string | undefined;
  const to = req.query.to as string | undefined;
  const { gte, lte } = parseDateRange(from, to);
  const outletId = resolveOutletScope(req) ?? undefined;

  const where: any = { createdAt: { gte, lte } };
  if (outletId) where.outletId = outletId;

  const requests = await prisma.orderCancellationRequest.findMany({
    where,
    select: {
      reason: true,
      refundAmount: true,
      penaltyAmount: true,
      status: true,
      responsibleUserId: true,
      responsibleUser: { select: { name: true } },
    },
  });

  const approved = requests.filter((r) => r.status === 'approved');
  const rejected = requests.filter((r) => r.status === 'rejected').length;
  const pending = requests.filter((r) => r.status === 'pending').length;
  const totalRefunded = Math.round(approved.reduce((s, r) => s + Number(r.refundAmount), 0));
  const totalPenalties = Math.round(approved.reduce((s, r) => s + Number(r.penaltyAmount), 0));

  const byReasonMap = new Map<string, { count: number; refunded: number }>();
  for (const r of approved) {
    const key = r.reason || 'Unspecified';
    const cur = byReasonMap.get(key) ?? { count: 0, refunded: 0 };
    cur.count += 1;
    cur.refunded += Number(r.refundAmount);
    byReasonMap.set(key, cur);
  }
  const byReason = [...byReasonMap.entries()]
    .map(([reason, v]) => ({ reason, count: v.count, refunded: Math.round(v.refunded) }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 8);

  const byStaffMap = new Map<string, { id: string; name: string; count: number; penalty: number }>();
  for (const r of approved) {
    if (!r.responsibleUserId) continue;
    const cur = byStaffMap.get(r.responsibleUserId) ?? { id: r.responsibleUserId, name: r.responsibleUser?.name ?? 'Unknown', count: 0, penalty: 0 };
    cur.count += 1;
    cur.penalty += Number(r.penaltyAmount);
    byStaffMap.set(r.responsibleUserId, cur);
  }
  const byStaff = [...byStaffMap.values()]
    .map((v) => ({ ...v, penalty: Math.round(v.penalty) }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 8);

  res.json(
    ApiResponse.success({
      from: from!,
      to: to!,
      totalRequests: requests.length,
      approved: approved.length,
      rejected,
      pending,
      totalRefunded,
      totalPenalties,
      byReason,
      byStaff,
    })
  );
});

/**
 * GET /api/reports/purchases-by-supplier
 *
 * Backs the Dashboard's "Purchases & Supplier Spend" section — date range only (a purchase is a
 * discrete event, not hourly). Groups `Purchase` rows by supplier over `Purchase.date` (a plain
 * `@db.Date` column, unlike `Order.createdAt` — no PKT shift needed here, plain UTC-midnight
 * boundaries are correct, same as `getExpenses`). Uses the identical outlet-scoping OR-clause
 * `getPurchases` uses (Super Admin -> MAIN-warehouse/chain-wide rows; branch role -> their
 * outlet's warehouse rows OR outlet-tagged no-warehouse rows) rather than a plain
 * `where.outletId = scope`, since `Purchase.outletId` alone isn't reliably populated for every
 * row — see `getPurchases`'s own comment for why. Unlike the Sales-side "by X" endpoints, `rows`
 * here is NOT capped at top 8 — every supplier with activity in range is returned (frontend caps
 * the chart only), matching `getSalesByStaff`/`getSalesByOutlet`'s convention.
 */
export const getPurchasesBySupplier = asyncHandler(async (req: Request, res: Response) => {
  const from = req.query.from as string | undefined;
  const to = req.query.to as string | undefined;

  const where: any = {};
  if (from || to) {
    const startStr = from ?? to!;
    const endStr = to ?? from!;
    const gte = new Date(`${startStr}T00:00:00.000Z`);
    const lt = new Date(`${endStr}T00:00:00.000Z`);
    lt.setUTCDate(lt.getUTCDate() + 1);
    where.date = { gte, lt };
  }

  const scope = resolveOutletScope(req);
  if (req.user?.role === 'Super Admin') {
    where.OR = [
      { warehouse: { outletId: null } },
      { AND: [{ warehouseId: null }, { outletId: null }] },
    ];
  } else if (scope) {
    where.OR = [
      { warehouse: { outletId: scope } },
      { AND: [{ warehouseId: null }, { outletId: scope }] },
    ];
  }

  const purchases = await prisma.purchase.findMany({
    where,
    select: {
      supplierId: true,
      supplier: { select: { name: true } },
      total: true,
      paid: true,
      due: true,
    },
  });

  interface SupplierAgg { id: string; name: string; count: number; total: number; paid: number; due: number }
  const bySupplier = new Map<string, SupplierAgg>();
  for (const p of purchases) {
    const key = p.supplierId ?? '__none__';
    const cur = bySupplier.get(key) ?? {
      id: p.supplierId ?? '',
      name: p.supplier?.name ?? 'No Supplier',
      count: 0, total: 0, paid: 0, due: 0,
    };
    cur.count += 1;
    cur.total += Number(p.total ?? 0);
    cur.paid += Number(p.paid ?? 0);
    cur.due += Number(p.due ?? 0);
    bySupplier.set(key, cur);
  }
  const rows = [...bySupplier.values()]
    .map((s) => ({ ...s, total: Math.round(s.total), paid: Math.round(s.paid), due: Math.round(s.due) }))
    .sort((a, b) => b.total - a.total);

  const totalAmount = Math.round(purchases.reduce((s, p) => s + Number(p.total ?? 0), 0));
  const totalPaid = Math.round(purchases.reduce((s, p) => s + Number(p.paid ?? 0), 0));
  const totalDue = Math.round(purchases.reduce((s, p) => s + Number(p.due ?? 0), 0));

  res.json(
    ApiResponse.success({
      from: from ?? null,
      to: to ?? null,
      purchaseCount: purchases.length,
      supplierCount: bySupplier.size,
      totalAmount,
      totalPaid,
      totalDue,
      rows,
    })
  );
});

/** Fixed category list Expenses.tsx offers — zero-filled the same way getSalesByCategory /
 *  getSalesByPaymentMethod zero-fill their own rows, so an inactive category still shows as
 *  Rs. 0 rather than being silently absent. "Uncategorized" is NOT in this list — like
 *  getNetProfit's own expenseByCategory map, it only appears when it has real activity. */
const FIXED_EXPENSE_CATEGORIES = ['Utilities', 'Rent', 'Salary', 'Maintenance', 'Marketing', 'Misc'];

/**
 * GET /api/reports/expenses-breakdown
 *
 * Backs the Dashboard's "Expenses Breakdown & Trends" section — date range only (an expense is a
 * discrete, day-granularity record, not hourly; same reasoning as Net Profit/Purchases by
 * Supplier). Over `Expense.date` — a plain `@db.Date` column like `Purchase.date`, so plain
 * UTC-midnight boundaries are correct here with no PKT shift (unlike `parseDateRange`'s
 * `Order.createdAt` handling — see that function's doc comment for why the two differ).
 *
 * Two views over the same rows: `byCategory` (zero-filled against the fixed list) feeds the
 * category chart/table and each row's drill-down into `/expenses?category=`; `trend` is one
 * point per calendar day in the range (zero-filled so the line chart has no gaps), feeding the
 * trend chart and each point's drill-down into `/expenses?from=<day>&to=<day>`.
 */
export const getExpensesBreakdown = asyncHandler(async (req: Request, res: Response) => {
  const from = req.query.from as string | undefined;
  const to = req.query.to as string | undefined;

  const where: any = {};
  if (from || to) {
    const startStr = from ?? to!;
    const endStr = to ?? from!;
    const gte = new Date(`${startStr}T00:00:00.000Z`);
    const lt = new Date(`${endStr}T00:00:00.000Z`);
    lt.setUTCDate(lt.getUTCDate() + 1);
    where.date = { gte, lt };
  }

  const scope = resolveOutletScope(req);
  if (scope) where.outletId = scope;

  const rows = await prisma.expense.findMany({
    where,
    select: { amount: true, category: true, date: true },
  });

  const totalAmount = Math.round(rows.reduce((s, e) => s + Number(e.amount), 0));
  const totalCount = rows.length;

  const catMap = new Map<string, { amount: number; count: number }>();
  for (const e of rows) {
    const name = e.category ?? 'Uncategorized';
    const cur = catMap.get(name) ?? { amount: 0, count: 0 };
    cur.amount += Number(e.amount);
    cur.count += 1;
    catMap.set(name, cur);
  }
  for (const name of FIXED_EXPENSE_CATEGORIES) {
    if (!catMap.has(name)) catMap.set(name, { amount: 0, count: 0 });
  }
  const byCategory = [...catMap.entries()]
    .map(([name, v]) => ({ name, amount: Math.round(v.amount), count: v.count }))
    .filter((r) => r.amount > 0 || FIXED_EXPENSE_CATEGORIES.includes(r.name))
    .sort((a, b) => b.amount - a.amount);

  const dayMap = new Map<string, number>();
  for (const e of rows) {
    const key = e.date.toISOString().slice(0, 10);
    dayMap.set(key, (dayMap.get(key) ?? 0) + Number(e.amount));
  }
  const trend: { date: string; amount: number }[] = [];
  if (from || to) {
    const startStr = from ?? to!;
    const endStr = to ?? from!;
    const cursor = new Date(`${startStr}T00:00:00.000Z`);
    const end = new Date(`${endStr}T00:00:00.000Z`);
    while (cursor.getTime() <= end.getTime()) {
      const key = cursor.toISOString().slice(0, 10);
      trend.push({ date: key, amount: Math.round(dayMap.get(key) ?? 0) });
      cursor.setUTCDate(cursor.getUTCDate() + 1);
    }
  }

  const avgPerDay = Math.round(totalAmount / (trend.length || 1));

  res.json(
    ApiResponse.success({
      from: from ?? null,
      to: to ?? null,
      totalAmount,
      totalCount,
      avgPerDay,
      byCategory,
      trend,
    })
  );
});

/** Fixed reason list StockAdjustments.tsx offers — same zero-fill convention as
 *  FIXED_EXPENSE_CATEGORIES above. "Unspecified" (blank reason) and any dynamic reason not on
 *  this list (e.g. the auto-expiry system's "Expired (auto waste)" string) only appear with real
 *  activity, same as getNetProfit's own wasteByReason map. */
const FIXED_WASTE_REASONS = ['Expired', 'Spoiled', 'Overcooked', 'Accidental', 'Damaged', 'Other'];

/**
 * GET /api/reports/waste-breakdown
 *
 * Backs the Dashboard's "Waste / Food Loss Trends" section — date range only, same shape as
 * Expenses Breakdown above (a discrete daily record, not hourly). Also backs
 * StockAdjustments.tsx's own summary tiles, which additionally pass `warehouseId`/`reason` so
 * those tiles stay in sync with that page's own dropdowns (both optional, ignored when absent).
 *
 * Deliberately mirrors stock.controller.ts's own getWasteRecords date-boundary convention (plain
 * UTC-midnight) rather than this file's own getNetProfit — even though WasteRecord.date is a real
 * DateTime (not @db.Date like Expense/Purchase), because this section's row/chart drill-down
 * lands on /stock/adjustments?from=&to=[&reason=], which getWasteRecords itself renders. Matching
 * getWasteRecords keeps this section's totals reconcilable with what that destination page
 * actually shows; matching getNetProfit's PKT-shifted parseDateRange instead would silently
 * disagree with it for any waste record logged 00:00-05:00 PKT. getNetProfit's own wasteRows
 * query is left exactly as-is — this is a known, pre-existing inconsistency between the two, not
 * introduced here.
 */
export const getWasteBreakdown = asyncHandler(async (req: Request, res: Response) => {
  const from = req.query.from as string | undefined;
  const to = req.query.to as string | undefined;
  // Optional -- StockAdjustments.tsx's own summary tiles pass these to stay in sync with the
  // page's warehouse/reason dropdowns; the Dashboard section never sends either, so its query
  // behavior is unchanged.
  const warehouseId = req.query.warehouseId as string | undefined;
  const reason = req.query.reason as string | undefined;

  const where: any = {};
  if (from || to) {
    const startStr = from ?? to!;
    const endStr = to ?? from!;
    const gte = new Date(`${startStr}T00:00:00.000Z`);
    const lt = new Date(`${endStr}T00:00:00.000Z`);
    lt.setUTCDate(lt.getUTCDate() + 1);
    where.date = { gte, lt };
  }
  if (warehouseId) where.warehouseId = warehouseId;
  if (reason) where.reason = reason;

  const scope = resolveOutletScope(req);
  if (scope) where.outletId = scope;

  const rows = await prisma.wasteRecord.findMany({
    where,
    select: { cost: true, reason: true, date: true },
  });

  const totalAmount = Math.round(rows.reduce((s, w) => s + Number(w.cost ?? 0), 0));
  const totalCount = rows.length;

  const reasonMap = new Map<string, { amount: number; count: number }>();
  for (const w of rows) {
    const name = w.reason?.trim() || 'Unspecified';
    const cur = reasonMap.get(name) ?? { amount: 0, count: 0 };
    cur.amount += Number(w.cost ?? 0);
    cur.count += 1;
    reasonMap.set(name, cur);
  }
  for (const name of FIXED_WASTE_REASONS) {
    if (!reasonMap.has(name)) reasonMap.set(name, { amount: 0, count: 0 });
  }
  const byReason = [...reasonMap.entries()]
    .map(([name, v]) => ({ name, amount: Math.round(v.amount), count: v.count }))
    .filter((r) => r.amount > 0 || FIXED_WASTE_REASONS.includes(r.name))
    .sort((a, b) => b.amount - a.amount);

  const dayMap = new Map<string, number>();
  for (const w of rows) {
    const key = w.date.toISOString().slice(0, 10);
    dayMap.set(key, (dayMap.get(key) ?? 0) + Number(w.cost ?? 0));
  }
  const trend: { date: string; amount: number }[] = [];
  if (from || to) {
    const startStr = from ?? to!;
    const endStr = to ?? from!;
    const cursor = new Date(`${startStr}T00:00:00.000Z`);
    const end = new Date(`${endStr}T00:00:00.000Z`);
    while (cursor.getTime() <= end.getTime()) {
      const key = cursor.toISOString().slice(0, 10);
      trend.push({ date: key, amount: Math.round(dayMap.get(key) ?? 0) });
      cursor.setUTCDate(cursor.getUTCDate() + 1);
    }
  }

  const avgPerDay = Math.round(totalAmount / (trend.length || 1));

  res.json(
    ApiResponse.success({
      from: from ?? null,
      to: to ?? null,
      totalAmount,
      totalCount,
      avgPerDay,
      byReason,
      trend,
    })
  );
});

const ATTENDANCE_STATUSES = ['present', 'late', 'halfday', 'absent'] as const;

/**
 * GET /api/reports/attendance
 *
 * Backs the Dashboard's "Attendance / HR Analytics" section — date range only (a day-granularity
 * record, not hourly). **`AttendanceRecord.date` is a plain `String` "YYYY-MM-DD" (a PKT calendar
 * date), not a `DateTime`** — unlike every other date-range endpoint in this file, this does NOT
 * go through `parseDateRange` (which builds UTC `Date` boundaries for a real timestamp column like
 * `Order.createdAt`) and does NOT need any PKT shift: `from`/`to` are compared directly against
 * the string field via Prisma's lexicographic `gte`/`lte`, exactly like `getAllAttendance`
 * (`attendance.controller.ts`) already does for its own `startDate`/`endDate` params. See
 * CLAUDE.md's "PKT Timezone Pattern" section's `AttendanceRecord.date` note.
 *
 * Counts by status — `present`/`late`/`halfday`/`absent` (the schema comment only lists three,
 * but `correctAttendance`'s zod enum and the frontend both use `halfday` too; `getDashboard`'s
 * own `attendanceToday` silently drops it into neither present/late/absent — this endpoint
 * buckets it explicitly instead of losing it the same way) — plus total overtime minutes and a
 * per-staff breakdown (NOT capped server-side, matching `getSalesByStaff`/`getSalesByOutlet`'s
 * convention) and a daily trend (zero-filled across every day in range, one stacked point per
 * status, for the section's chart).
 */
export const getAttendanceAnalytics = asyncHandler(async (req: Request, res: Response) => {
  const from = req.query.from as string | undefined;
  const to = req.query.to as string | undefined;
  if (!from || !to) throw ApiError.badRequest('from and to are required (YYYY-MM-DD)');

  const where: any = { date: { gte: from, lte: to } };
  const scope = resolveOutletScope(req);
  if (scope) where.outletId = scope;

  const rows = await prisma.attendanceRecord.findMany({
    where,
    select: {
      userId: true, date: true, status: true, overtimeMinutes: true,
      user: { select: { name: true, role: true } },
    },
  });

  const totalOvertimeMinutes = rows.reduce((s, r) => s + (r.overtimeMinutes ?? 0), 0);
  const counts = { present: 0, late: 0, halfday: 0, absent: 0 };
  for (const r of rows) {
    if ((ATTENDANCE_STATUSES as readonly string[]).includes(r.status)) {
      counts[r.status as keyof typeof counts] += 1;
    }
  }
  const totalRecords = rows.length;
  const attendanceRate = totalRecords > 0
    ? Math.round(((counts.present + counts.late + counts.halfday) / totalRecords) * 100)
    : 0;

  interface StaffAgg {
    userId: string; name: string; role: string;
    present: number; late: number; halfday: number; absent: number; overtimeMinutes: number;
  }
  const byStaffMap = new Map<string, StaffAgg>();
  for (const r of rows) {
    const cur = byStaffMap.get(r.userId) ?? {
      userId: r.userId, name: r.user?.name ?? 'Unknown', role: r.user?.role ?? '',
      present: 0, late: 0, halfday: 0, absent: 0, overtimeMinutes: 0,
    };
    if ((ATTENDANCE_STATUSES as readonly string[]).includes(r.status)) {
      cur[r.status as keyof typeof counts] += 1;
    }
    cur.overtimeMinutes += r.overtimeMinutes ?? 0;
    byStaffMap.set(r.userId, cur);
  }
  const byStaff = [...byStaffMap.values()].sort((a, b) => (b.present + b.late) - (a.present + a.late));

  const dayMap = new Map<string, { present: number; late: number; halfday: number; absent: number }>();
  for (const r of rows) {
    const cur = dayMap.get(r.date) ?? { present: 0, late: 0, halfday: 0, absent: 0 };
    if ((ATTENDANCE_STATUSES as readonly string[]).includes(r.status)) {
      cur[r.status as keyof typeof counts] += 1;
    }
    dayMap.set(r.date, cur);
  }
  const trend: { date: string; present: number; late: number; halfday: number; absent: number }[] = [];
  const cursor = new Date(`${from}T00:00:00.000Z`);
  const end = new Date(`${to}T00:00:00.000Z`);
  while (cursor.getTime() <= end.getTime()) {
    const key = cursor.toISOString().slice(0, 10);
    const c = dayMap.get(key) ?? { present: 0, late: 0, halfday: 0, absent: 0 };
    trend.push({ date: key, ...c });
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }

  res.json(
    ApiResponse.success({
      from, to,
      totalRecords,
      present: counts.present,
      late: counts.late,
      halfday: counts.halfday,
      absent: counts.absent,
      attendanceRate,
      totalOvertimeMinutes,
      byStaff,
      trend,
    })
  );
});
