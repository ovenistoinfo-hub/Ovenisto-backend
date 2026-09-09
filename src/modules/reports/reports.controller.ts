/**
 * Reports Controller (Phase 1)
 * Server-side aggregation for Sales, P&L, Item-wise, and Stock reports.
 */
import type { Request, Response } from 'express';
import { prisma } from '../../config/database.js';
import { ApiResponse } from '../../utils/ApiResponse.js';
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
