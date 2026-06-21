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
  displayOrderType,
} from './reports.helpers.js';
import { resolveOutletScope } from '../../middleware/outletScope.js';

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
  const completedWhere = { ...baseWhere, status: COMPLETED as never };

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
  const completedWhere = { ...buildOrderWhere(gte, lte, outletId), status: COMPLETED as never };

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
    const ingredientIds = [...new Set(recipes.map((r) => r.ingredientId))];
    const ingredients = await prisma.ingredient.findMany({
      where: { id: { in: ingredientIds } },
      select: { id: true, purchasePrice: true },
    });
    const priceById = new Map(ingredients.map((i) => [i.id, Number(i.purchasePrice ?? 0)]));
    const allItems = completed.flatMap((o) => o.items);
    const recipesForCogs = recipes.map((r) => ({
      menuItemId: r.menuItemId,
      variantId: r.variantId,
      ingredientId: r.ingredientId,
      qtyPerUnit: Number(r.qtyPerUnit),
    }));
    cogs = computeCogs(allItems, recipesForCogs, priceById);
  }

  // Expenses: Expense has NO outletId column, so it is always restaurant-wide.
  const expenseRows = await prisma.expense.findMany({
    where: { date: { gte, lte } },
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

  const expensesAreRestaurantWide = !!outletId && outletId !== 'all';

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
  const completedWhere = { ...buildOrderWhere(gte, lte, outletId), status: COMPLETED as never };

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
    if (stock <= low) lowStockItems += 1;
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

// Prisma OrderStatus enum MEMBER names (not the @map db strings). Exclude cancelled + scheduled.
const EXCLUDED_STATUSES = ['CANCELLED', 'SCHEDULED'] as const;

/** GET /api/reports/dashboard?outletId=<id|all> */
export const getDashboard = asyncHandler(async (req: Request, res: Response) => {
  const outletId = resolveOutletScope(req) ?? undefined;
  const now = new Date();
  const day = dayBoundaries(now);
  const mb = monthBoundaries(now);

  const outletFilter = outletId ? { outletId } : {};
  const notExcluded = { status: { notIn: EXCLUDED_STATUSES as unknown as never } };

  // --- TODAY: orders by channel ---
  const todayOrders = await prisma.order.findMany({
    where: { ...outletFilter, ...notExcluded, createdAt: { gte: day.gte, lte: day.lte } },
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
    where: { ...outletFilter, ...notExcluded, createdAt: { gte: mb.thisStart, lte: mb.thisEnd } },
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
    where: { ...outletFilter, ...notExcluded, createdAt: { gte: mb.lastStart, lte: mb.lastEnd } },
    select: { type: true, total: true },
  });
  let lastOnline = 0, lastOffline = 0, lastTotal = 0;
  for (const o of lastOrders) {
    const amt = Number(o.total); lastTotal += amt;
    if (classifyChannel(displayOrderType(String(o.type))) === 'online') lastOnline += amt; else lastOffline += amt;
  }

  // --- expenses + waste this month (restaurant-wide; Expense has no outletId) ---
  const [expenseRows, wasteRows] = await Promise.all([
    prisma.expense.findMany({ where: { date: { gte: mb.thisStart, lte: mb.thisEnd } }, select: { amount: true } }),
    prisma.wasteRecord.findMany({ where: { date: { gte: mb.thisStart, lte: mb.thisEnd } }, select: { cost: true } }),
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
    where: { ...outletFilter, ...notExcluded, createdAt: { gte: weekStart, lte: weekEnd } },
    select: { total: true, createdAt: true },
  });
  const labels = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const dayTotals = [0, 0, 0, 0, 0, 0, 0];
  for (const o of weekOrders) {
    const idx = (new Date(o.createdAt).getUTCDay() + 6) % 7;
    dayTotals[idx] += Number(o.total);
  }
  const daywiseSales = labels.map((label, i) => ({ label, sales: Math.round(dayTotals[i]) }));

  // --- payable / receivable / settings / top customers ---
  const [supplierAgg, customerAgg, topCustomers, settings] = await Promise.all([
    prisma.supplier.aggregate({ _sum: { totalDue: true } }),
    prisma.customer.aggregate({ _sum: { outstandingDue: true } }),
    prisma.customer.findMany({
      orderBy: { totalSpent: 'desc' },
      take: 10,
      select: { name: true, totalOrders: true, totalSpent: true },
    }),
    prisma.settings.findFirst({ select: { restaurantName: true } }),
  ]);
  const payable = Math.round(Number(supplierAgg._sum.totalDue ?? 0));
  const receivable = Math.round(Number(customerAgg._sum.outstandingDue ?? 0));
  const topCustomersMapped = topCustomers.map((c) => ({ name: c.name, totalOrders: c.totalOrders, totalSpent: Number(c.totalSpent) }));

  // --- top items this month ---
  const monthItems = await prisma.orderItem.findMany({
    where: { order: { is: { ...outletFilter, ...notExcluded, createdAt: { gte: mb.thisStart, lte: mb.thisEnd } } } },
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

  res.json(ApiResponse.success({
    branchName: settings?.restaurantName ?? 'Ovenisto',
    today: {
      totalSales: todayTotalSales,
      totalOrders: todayOrders.length,
      channels,
      online: { sales: Math.round(onlineSales), orders: onlineOrders },
      offline: { sales: Math.round(offlineSales), orders: offlineOrders },
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
  }));
});
