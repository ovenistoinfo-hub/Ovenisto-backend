/**
 * Delivery / Rider Controller
 */
import type { Request, Response } from 'express';
import { prisma } from '../../config/database.js';
import { ApiResponse } from '../../utils/ApiResponse.js';
import { ApiError } from '../../utils/ApiError.js';
import { asyncHandler } from '../../utils/asyncHandler.js';
import { resolveOutletScope } from '../../middleware/outletScope.js';
import { checkPendingCancellation, runOrderStatusPostEffects } from '../order/order.controller.js';
import { emitDeliveryEvent } from '../../socket.js';
import { getCashierPaymentMethodString } from '../cash-settlement/cash-settlement.service.js';
import {
  normalizeOrderStatus,
  isOrderReadyForDispatch,
  canDispatch,
  isRiderTransitionAllowed,
} from './delivery.rules.js';
import { sendPushToUser } from '../notifications/push.service.js';
import { parseDateRange } from '../reports/reports.helpers.js';
import {
  getDefaultWeekRange,
  groupDeliveriesByDay,
  rankRiders,
  deriveHistoryPaymentLabel,
} from './delivery.helpers.js';

function mapRider(r: any) {
  return { ...r, activeDeliveries: Number(r.activeDeliveries ?? 0) };
}

function mapAssignment(a: any) {
  const orderStatus = a.order?.status ? normalizeOrderStatus(a.order.status) : undefined;
  const canDispatchFlag = a.order?.status ? canDispatch(a.order.status, a.status) : false;
  const items = a.order?.items ? a.order.items.map((i: any) => ({
    name: i.name,
    qty: Number(i.qty),
    notes: i.notes ?? null,
  })) : [];
  const paymentLabel = deriveHistoryPaymentLabel(a.status, a.order?.paymentMethod);

  return {
    ...a,
    amountToCollect:  a.amountToCollect  != null ? Number(a.amountToCollect)  : null,
    commissionRate:   Number(a.commissionRate   ?? 0),
    commissionEarned: Number(a.commissionEarned ?? 0),
    paymentLabel,
    ...(orderStatus !== undefined && { orderStatus }),
    canDispatch: canDispatchFlag,
    items,
    order: a.order ? {
      ...a.order,
      total:          Number(a.order.total ?? 0),
      subtotal:       Number(a.order.subtotal ?? 0),
      tax:            Number(a.order.tax ?? 0),
      discount:       Number(a.order.discount ?? 0),
      advancePayment: Number(a.order.advancePayment ?? 0),
    } : undefined,
    rider: a.rider ? mapRider(a.rider) : undefined,
  };
}

// ─── Rider CRUD ──────────────────────────────────────────────────────────────

/** GET /api/delivery/riders — derived from Users with role=Rider */
export const getRiders = asyncHandler(async (req: Request, res: Response) => {
  // Pull users with Rider role and join their DeliveryRider profile
  const scope = resolveOutletScope(req);
  const riderUsers = await prisma.user.findMany({
    where: { role: 'RIDER' as any, status: 'active', ...(scope ? { outletId: scope } : {}) },
    include: { riderProfile: true },
    orderBy: { name: 'asc' },
  });

  // Return DeliveryRider profiles (create on-the-fly for any without one)
  const profiles = await Promise.all(riderUsers.map(async u => {
    let profile = u.riderProfile;
    if (!profile) {
      profile = await prisma.deliveryRider.upsert({
        where: { userId: u.id },
        update: { name: u.name, phone: u.phone ?? null },
        create: { userId: u.id, name: u.name, phone: u.phone ?? null, status: 'available' },
      });
    }
    return mapRider({ ...profile, user: { id: u.id, email: u.email, status: u.status } });
  }));

  res.json(ApiResponse.success(profiles));
});

/** POST /api/delivery/riders — create rider profile */
export const createRider = asyncHandler(async (req: Request, res: Response) => {
  const { name, phone, userId } = req.body;
  if (!name?.trim()) throw ApiError.badRequest('Rider name is required');

  if (userId) {
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw ApiError.notFound('User not found');
    const scope = resolveOutletScope(req);
    if (scope && user.outletId !== scope) throw ApiError.badRequest('Rider user is not in your outlet');
    const existing = await prisma.deliveryRider.findUnique({ where: { userId } });
    if (existing) throw ApiError.badRequest('This user already has a rider profile');
  }

  const rider = await prisma.deliveryRider.create({ data: { name, phone: phone || null, userId: userId || null, status: 'available' } });
  res.status(201).json(ApiResponse.created(mapRider(rider), 'Rider created'));
});

/** PUT /api/delivery/riders/:id */
export const updateRider = asyncHandler(async (req: Request, res: Response) => {
  const { id } = req.params;
  const { name, phone, isAvailable, status, userId } = req.body;
  const rider = await prisma.deliveryRider.findUnique({ where: { id }, include: { user: { select: { outletId: true } } } });
  if (!rider) throw ApiError.notFound('Rider not found');
  const scope = resolveOutletScope(req);
  if (scope && rider.user?.outletId !== scope) throw ApiError.notFound('Rider not found');

  const updated = await prisma.deliveryRider.update({
    where: { id },
    data: {
      ...(name      !== undefined && { name }),
      ...(phone     !== undefined && { phone }),
      ...(isAvailable !== undefined && { isAvailable }),
      ...(status    !== undefined && { status }),
      ...(userId    !== undefined && { userId: userId || null }),
    },
  });
  res.json(ApiResponse.success(mapRider(updated)));
});

// ─── Assignments ─────────────────────────────────────────────────────────────

/** GET /api/delivery/assignments */
export const getAssignments = asyncHandler(async (req: Request, res: Response) => {
  const { riderId, status, date } = req.query as Record<string, string>;
  const where: any = {};
  if (riderId) where.riderId = riderId;
  if (status)  where.status  = status;
  if (date) {
    const start = new Date(date); start.setHours(0, 0, 0, 0);
    const end   = new Date(date); end.setHours(23, 59, 59, 999);
    where.assignedAt = { gte: start, lte: end };
  }

  const scope = resolveOutletScope(req);
  if (scope) where.order = { outletId: scope };

  const assignments = await prisma.deliveryAssignment.findMany({
    where,
    include: {
      order: { select: { id: true, orderNumber: true, total: true, subtotal: true, tax: true, discount: true, status: true, customerName: true, deliveryAddress: true, phone: true } },
      rider: true,
    },
    orderBy: { assignedAt: 'desc' },
  });
  res.json(ApiResponse.success(assignments.map(mapAssignment)));
});

/** GET /api/delivery/my-assignments — rider fetches their own (uses req.user) */
export const getMyAssignments = asyncHandler(async (req: Request, res: Response) => {
  const riderProfile = await prisma.deliveryRider.findUnique({ where: { userId: req.user!.id } });
  if (!riderProfile) throw ApiError.notFound('No rider profile linked to your account. Ask admin to link your profile.');

  const assignments = await prisma.deliveryAssignment.findMany({
    where: {
      riderId: riderProfile.id,
      status: { in: ['pending', 'accepted', 'dispatched'] },
      order: { status: { not: 'CANCELLED' } },
    },
    include: {
      order: {
        select: {
          id: true,
          orderNumber: true,
          total: true,
          subtotal: true,
          tax: true,
          discount: true,
          advancePayment: true,
          paymentMethod: true,
          status: true,
          customerName: true,
          deliveryAddress: true,
          phone: true,
          type: true,
          tableNumber: true,
          items: {
            where: { status: 'active' },
            select: { name: true, qty: true, notes: true },
          },
        },
      },
    },
    orderBy: { assignedAt: 'desc' },
  });
  res.json(ApiResponse.success({ rider: mapRider(riderProfile), assignments: assignments.map(mapAssignment) }));
});

/** GET /api/delivery/my-stats — rider's earnings summary */
export const getMyStats = asyncHandler(async (req: Request, res: Response) => {
  const riderProfile = await prisma.deliveryRider.findUnique({ where: { userId: req.user!.id } });
  if (!riderProfile) throw ApiError.notFound('No rider profile linked to your account.');

  const today = new Date(); today.setHours(0, 0, 0, 0);
  const [todayAssignments, allAssignments] = await Promise.all([
    prisma.deliveryAssignment.findMany({
      where: { riderId: riderProfile.id, status: 'delivered', deliveredAt: { gte: today } },
      include: { order: { select: { total: true } } },
    }),
    prisma.deliveryAssignment.findMany({
      where: { riderId: riderProfile.id, status: 'delivered' },
      include: { order: { select: { total: true } } },
    }),
  ]);

  const todaySales        = todayAssignments.reduce((s, a) => s + Number(a.order?.total ?? 0), 0);
  const todayCommissions  = todayAssignments.reduce((s, a) => s + Number(a.commissionEarned ?? 0), 0);
  const totalSales        = allAssignments.reduce((s, a)   => s + Number(a.order?.total ?? 0), 0);
  const totalCommissions  = allAssignments.reduce((s, a)   => s + Number(a.commissionEarned ?? 0), 0);

  // NOTE: For currently uncleared cash held by this rider, use canonical endpoint GET /api/cash-settlements/staff/:staffId/active with staffId = req.user.id

  res.json(ApiResponse.success({
    rider: mapRider(riderProfile),
    todayOrders:  todayAssignments.length,
    todaySales,
    todayCommissions,
    totalOrders:  allAssignments.length,
    totalSales,
    totalCommissions,
  }));
});

/** GET /api/delivery/my-profile — rider fetches their combined profile */
export const getMyProfile = asyncHandler(async (req: Request, res: Response) => {
  const riderProfile = await prisma.deliveryRider.findUnique({
    where: { userId: req.user!.id },
    include: {
      user: {
        select: {
          id: true,
          name: true,
          email: true,
          phone: true,
          outlet: { select: { id: true, name: true } },
        },
      },
    },
  });
  if (!riderProfile) {
    throw ApiError.notFound('No rider profile linked to your account. Ask admin to link your profile.');
  }

  res.json(
    ApiResponse.success({
      ...mapRider(riderProfile),
      user: riderProfile.user
        ? {
            id: riderProfile.user.id,
            name: riderProfile.user.name,
            email: riderProfile.user.email,
            phone: riderProfile.user.phone ?? null,
            outlet: riderProfile.user.outlet
              ? { id: riderProfile.user.outlet.id, name: riderProfile.user.outlet.name }
              : null,
          }
        : null,
    })
  );
});

/** PATCH /api/delivery/my-status — self-service availability toggle */
export const updateMyStatus = asyncHandler(async (req: Request, res: Response) => {
  const riderProfile = await prisma.deliveryRider.findUnique({ where: { userId: req.user!.id } });
  if (!riderProfile) {
    throw ApiError.notFound('No rider profile linked to your account. Ask admin to link your profile.');
  }

  const { isAvailable } = req.body;
  if (typeof isAvailable !== 'boolean') {
    throw ApiError.badRequest('isAvailable must be a boolean');
  }

  if (riderProfile.status === 'on_delivery') {
    throw ApiError.badRequest('Cannot go offline while on an active delivery');
  }

  const updated = await prisma.deliveryRider.update({
    where: { id: riderProfile.id },
    data: {
      isAvailable,
      status: isAvailable ? 'available' : 'offline',
    },
  });

  res.json(ApiResponse.success(mapRider(updated)));
});

/** GET /api/delivery/my-history — paginated delivery history (delivered and returned) */
export const getMyHistory = asyncHandler(async (req: Request, res: Response) => {
  const riderProfile = await prisma.deliveryRider.findUnique({ where: { userId: req.user!.id } });
  if (!riderProfile) {
    throw ApiError.notFound('No rider profile linked to your account. Ask admin to link your profile.');
  }

  const page = Math.max(1, parseInt(req.query.page as string, 10) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit as string, 10) || 20));
  const skip = (page - 1) * limit;

  const { from, to, status, q } = req.query as {
    from?: string;
    to?: string;
    status?: string;
    q?: string;
  };

  if (status && status !== 'delivered' && status !== 'returned') {
    throw ApiError.badRequest('status must be delivered or returned');
  }

  const where: any = {
    riderId: riderProfile.id,
    status: status || { in: ['delivered', 'returned'] },
  };

  const andClauses: any[] = [];

  if (from || to) {
    const f = from ?? to!;
    const t = to ?? from!;
    if (f > t) {
      throw ApiError.badRequest('from date must be before or equal to to date');
    }
    const { gte, lte } = parseDateRange(f, t);
    andClauses.push({
      OR: [
        { deliveredAt: { not: null, gte, lte } },
        { deliveredAt: null, assignedAt: { gte, lte } },
      ],
    });
  }

  if (q && typeof q === 'string' && q.trim()) {
    andClauses.push({
      order: {
        orderNumber: { contains: q.trim(), mode: 'insensitive' },
      },
    });
  }

  if (andClauses.length > 0) {
    where.AND = andClauses;
  }

  const [total, assignments] = await Promise.all([
    prisma.deliveryAssignment.count({ where }),
    prisma.deliveryAssignment.findMany({
      where,
      include: {
        order: {
          select: {
            id: true,
            orderNumber: true,
            total: true,
            subtotal: true,
            tax: true,
            discount: true,
            advancePayment: true,
            paymentMethod: true,
            status: true,
            customerName: true,
            deliveryAddress: true,
            phone: true,
            type: true,
            tableNumber: true,
            items: {
              where: { status: 'active' },
              select: { name: true, qty: true, notes: true },
            },
          },
        },
      },
      orderBy: { assignedAt: 'desc' },
      skip,
      take: limit,
    }),
  ]);

  res.json(ApiResponse.paginated(assignments.map(mapAssignment), page, limit, total));
});

/** GET /api/delivery/my-earnings — rider's earnings by date range */
export const getMyEarnings = asyncHandler(async (req: Request, res: Response) => {
  const riderProfile = await prisma.deliveryRider.findUnique({ where: { userId: req.user!.id } });
  if (!riderProfile) {
    throw ApiError.notFound('No rider profile linked to your account. Ask admin to link your profile.');
  }

  const def = getDefaultWeekRange();
  const from = (req.query.from as string) || def.from;
  const to = (req.query.to as string) || def.to;
  if (from > to) {
    throw ApiError.badRequest('from date must be before or equal to to date');
  }
  const { gte, lte } = parseDateRange(from, to);

  const assignments = await prisma.deliveryAssignment.findMany({
    where: {
      riderId: riderProfile.id,
      status: 'delivered',
      deliveredAt: { gte, lte },
    },
    select: {
      deliveredAt: true,
      commissionEarned: true,
      order: { select: { total: true } },
    },
    orderBy: { deliveredAt: 'asc' },
  });

  const result = groupDeliveriesByDay(assignments, from, to);

  res.json(
    ApiResponse.success({
      from,
      to,
      ...result,
    })
  );
});

/** GET /api/delivery/rankings — outlet rider rankings / leaderboard */
export const getRiderRankings = asyncHandler(async (req: Request, res: Response) => {
  const scope = resolveOutletScope(req);

  const def = getDefaultWeekRange();
  const from = (req.query.from as string) || def.from;
  const to = (req.query.to as string) || def.to;
  if (from > to) {
    throw ApiError.badRequest('from date must be before or equal to to date');
  }
  const { gte, lte } = parseDateRange(from, to);

  const riders = await prisma.deliveryRider.findMany({
    where: {
      user: {
        status: 'active',
        ...(scope ? { outletId: scope } : {}),
      },
    },
    select: {
      id: true,
      name: true,
    },
    orderBy: { name: 'asc' },
  });

  const riderIds = riders.map((r) => r.id);
  const deliveredAssignments = riderIds.length > 0
    ? await prisma.deliveryAssignment.findMany({
        where: {
          riderId: { in: riderIds },
          status: 'delivered',
          deliveredAt: { gte, lte },
        },
        select: {
          riderId: true,
          commissionEarned: true,
        },
      })
    : [];

  const statsMap = new Map<string, { deliveries: number; commissionEarned: number }>();
  for (const a of deliveredAssignments) {
    const cur = statsMap.get(a.riderId) ?? { deliveries: 0, commissionEarned: 0 };
    cur.deliveries += 1;
    cur.commissionEarned += Number(a.commissionEarned ?? 0);
    statsMap.set(a.riderId, cur);
  }

  const rankings = riders.map((r) => {
    const stats = statsMap.get(r.id) ?? { deliveries: 0, commissionEarned: 0 };
    return {
      riderId: r.id,
      name: r.name,
      deliveries: stats.deliveries,
      commissionEarned: stats.commissionEarned,
    };
  });

  const isManager = ['Super Admin', 'Admin', 'Manager'].includes(req.user?.role as string);
  const callerProfile = req.user?.id
    ? await prisma.deliveryRider.findUnique({ where: { userId: req.user.id } })
    : null;
  const callerRiderId = callerProfile?.id ?? null;

  const ranked = rankRiders(rankings, callerRiderId, isManager);

  res.json(ApiResponse.success(ranked));
});


/** POST /api/delivery/assign */
export const assignRider = asyncHandler(async (req: Request, res: Response) => {
  const { orderId, riderId, estimatedTime, notes } = req.body;
  if (!orderId || !riderId) throw ApiError.badRequest('orderId and riderId are required');

  const [order, rider] = await Promise.all([
    prisma.order.findUnique({ where: { id: orderId } }),
    prisma.deliveryRider.findUnique({ where: { id: riderId }, include: { user: { select: { outletId: true } } } }),
  ]);
  if (!order)  throw ApiError.notFound('Order not found');
  if (!rider)  throw ApiError.notFound('Rider not found');

  // If acting user is a Rider, enforce that they can only assign/claim for themselves
  if (req.user?.role === 'Rider' as any && rider.userId !== req.user?.id) {
    throw ApiError.forbidden('Riders can only claim delivery orders for themselves');
  }

  const scope = resolveOutletScope(req);
  if (scope && order.outletId !== scope) throw ApiError.notFound('Order not found');
  if (scope && rider.user?.outletId !== scope) throw ApiError.badRequest('Rider is not in your outlet');
  if (rider.status === 'off_duty' || rider.status === 'offline') throw ApiError.badRequest('Rider is currently off duty');
  if ((rider.activeDeliveries || 0) >= 5) throw ApiError.badRequest('Rider has reached maximum active delivery limit (5 orders)');

  const existing = await prisma.deliveryAssignment.findFirst({ where: { orderId, status: { notIn: ['returned'] } } });
  if (existing) throw ApiError.badRequest('Order already has an active assignment');

  const nextActiveCount = (rider.activeDeliveries || 0) + 1;

  const [assignment] = await prisma.$transaction([
    prisma.deliveryAssignment.create({
      data: {
        orderId, riderId,
        status: 'pending',
        estimatedTime:   estimatedTime || 30,
        customerAddress: order.deliveryAddress || '',
        customerPhone:   order.phone || '',
        amountToCollect: (() => {
          const pm = (order.paymentMethod || '').trim();
          const pmLower = pm.toLowerCase();
          const isCOD = pmLower === 'cash on delivery' || pmLower === 'cod' || pmLower === 'cash-on-delivery';
          const advance = Number(order.advancePayment ?? 0);
          const orderTotal = Number(order.total);
          const isPrepaid = (advance > 0 && advance >= orderTotal) || (!isCOD && !pm.includes('Advance (') && !pm.includes('COD Balance (') && pmLower !== 'pending' && pmLower !== 'unpaid' && pm !== '');

          if (isPrepaid) return 0;
          if (isCOD) return orderTotal;
          return Math.max(0, orderTotal - advance);
        })(),
        notes: notes || null,
      },
      include: { order: { select: { id: true, orderNumber: true, total: true, customerName: true, deliveryAddress: true, type: true, tableNumber: true, status: true } }, rider: true },
    }),
    prisma.deliveryRider.update({
      where: { id: riderId },
      data: {
        activeDeliveries: { increment: 1 },
        isAvailable: nextActiveCount < 5,
        status: 'on_delivery',
      },
    }),
    prisma.order.update({ where: { id: orderId }, data: { riderId } }),
  ]);

  // Emit real-time event so Delivery.tsx and RiderPortal.tsx update live
  emitDeliveryEvent('delivery:assigned', {
    assignmentId: assignment.id,
    orderId,
    riderId,
    orderNumber: order.orderNumber,
    outletId: order.outletId,
    orderStatus: normalizeOrderStatus(order.status),
  }, [order.outletId]);

  if (rider.userId) {
    sendPushToUser(rider.userId, {
      title: 'New Delivery Assigned',
      body: `Order ${order.orderNumber} has been assigned to you`,
      data: {
        orderId: order.id,
        assignmentId: assignment.id,
        type: 'new_assignment',
      },
    });
  }

  res.status(201).json(ApiResponse.created(mapAssignment(assignment), 'Rider assigned'));
});

/** PUT /api/delivery/assignments/:id/status */
export const updateAssignmentStatus = asyncHandler(async (req: Request, res: Response) => {
  const { id } = req.params;
  const { status, paymentMethod } = req.body;

  const allowed = ['accepted', 'dispatched', 'delivered', 'returned'];
  if (!allowed.includes(status)) throw ApiError.badRequest(`Status must be one of: ${allowed.join(', ')}`);

  const assignment = await prisma.deliveryAssignment.findUnique({
    where: { id },
    include: {
      rider: true,
      order: {
        select: {
          id: true,
          orderNumber: true,
          outletId: true,
          total: true,
          subtotal: true,
          tax: true,
          discount: true,
          advancePayment: true,
          paymentMethod: true,
          customerName: true,
          deliveryAddress: true,
          phone: true,
          type: true,
          tableNumber: true,
          status: true,
        },
      },
    },
  });
  if (!assignment) throw ApiError.notFound('Assignment not found');
  const scope = resolveOutletScope(req);
  if (scope && assignment.order?.outletId !== scope) throw ApiError.notFound('Assignment not found');

  // b. Ownership: if req.user.role === 'Rider', require assignment.rider.userId === req.user.id
  // Must run BEFORE idempotency — otherwise a rider who learns another rider's
  // assignmentId (broadcast outlet-wide via delivery:assigned/status_updated) could
  // read that assignment's full order/customer details by guessing its current status.
  if (req.user?.role === 'Rider' && assignment.rider.userId !== req.user.id) {
    throw ApiError.forbidden('This delivery is assigned to another rider');
  }

  // a. Idempotency: if requested status === current assignment status, return current mapped assignment (200) with NO side effects
  if (status === assignment.status) {
    res.json(ApiResponse.success(mapAssignment(assignment)));
    return;
  }

  // c. Rider transitions: for role Rider enforce isRiderTransitionAllowed, else ApiError.badRequest
  if (req.user?.role === 'Rider' && !isRiderTransitionAllowed(assignment.status, status)) {
    throw ApiError.badRequest(`Cannot transition assignment from ${assignment.status} to ${status}`);
  }

  // d. Kitchen gate for ALL roles, only for status === 'dispatched'
  if (status === 'dispatched') {
    const updatedAssignment = await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT 1 FROM "orders" WHERE id = ${assignment.orderId} FOR UPDATE`;

      const [lockedOrder, lockedAssignment] = await Promise.all([
        tx.order.findUniqueOrThrow({
          where: { id: assignment.orderId },
          select: {
            id: true,
            orderNumber: true,
            total: true,
            subtotal: true,
            tax: true,
            discount: true,
            advancePayment: true,
            paymentMethod: true,
            customerName: true,
            deliveryAddress: true,
            phone: true,
            status: true,
            outletId: true,
          },
        }),
        tx.deliveryAssignment.findUniqueOrThrow({
          where: { id },
          include: { rider: true },
        }),
      ]);

      if (lockedAssignment.status === 'dispatched') {
        return { ...lockedAssignment, order: lockedOrder };
      }

      if (req.user?.role === 'Rider' && !isRiderTransitionAllowed(lockedAssignment.status, 'dispatched')) {
        throw ApiError.badRequest(`Cannot transition assignment from ${lockedAssignment.status} to dispatched`);
      }

      const normOrderStatus = normalizeOrderStatus(lockedOrder.status);
      if (normOrderStatus === 'cancelled') {
        throw ApiError.conflict('Order was cancelled');
      }
      if (lockedAssignment.status !== 'accepted' || !isOrderReadyForDispatch(lockedOrder.status)) {
        throw ApiError.conflict('Order is not ready yet - the kitchen is still preparing it');
      }

      const updated = await tx.deliveryAssignment.update({
        where: { id },
        data: {
          status: 'dispatched',
          dispatchedAt: new Date(),
        },
        include: {
          order: {
            select: {
              id: true,
              orderNumber: true,
              total: true,
              subtotal: true,
              tax: true,
              discount: true,
              advancePayment: true,
              paymentMethod: true,
              customerName: true,
              deliveryAddress: true,
              phone: true,
              status: true,
            },
          },
          rider: true,
        },
      });

      return updated;
    }, { timeout: 30000 });

    emitDeliveryEvent('delivery:status_updated', {
      assignmentId: id,
      status: 'dispatched',
      riderId: assignment.riderId,
      outletId: assignment.order?.outletId,
    }, [assignment.order?.outletId]);

    res.json(ApiResponse.success(mapAssignment(updatedAssignment)));
    return;
  }

  const data: any = { status };
  if (status === 'accepted')   data.acceptedAt   = new Date();
  if (status === 'delivered')  data.deliveredAt  = new Date();

  // When delivered, look up the rider's Employee profile to stamp commission
  let commissionPerDelivery = 0;
  if (status === 'delivered' && assignment.rider.userId) {
    const employeeProfile = await prisma.employee.findUnique({
      where: { userId: assignment.rider.userId },
      select: { commissionPerDelivery: true },
    });
    commissionPerDelivery = Number(employeeProfile?.commissionPerDelivery ?? 0);
  }
  if (status === 'delivered') {
    data.commissionRate   = commissionPerDelivery;
    data.commissionEarned = commissionPerDelivery;
  }

  const ops: any[] = [
    prisma.deliveryAssignment.update({
      where: { id },
      data,
      include: {
        order: {
          select: {
            id: true,
            orderNumber: true,
            total: true,
            subtotal: true,
            tax: true,
            discount: true,
            advancePayment: true,
            paymentMethod: true,
            customerName: true,
            deliveryAddress: true,
            phone: true,
            status: true,
          },
        },
        rider: true,
      },
    }),
  ];

  // Rider accepts → mark as on_delivery now (assignment was pending until this point)
  if (status === 'accepted') {
    ops.push(
      prisma.deliveryRider.update({
        where: { id: assignment.riderId },
        data: { status: 'on_delivery' },
      }),
    );
  }

  // When delivered — decrement active deliveries, restore availability, and transition order to COMPLETED
  let shouldCompleteOrder = false;

  if (status === 'delivered') {
    if (await checkPendingCancellation(assignment.orderId)) {
      throw ApiError.badRequest('Cannot mark delivered while a cancellation request is pending approval');
    }
    const currentRemaining = Math.max(0, (assignment.rider.activeDeliveries || 1) - 1);
    ops.push(
      prisma.deliveryRider.update({
        where: { id: assignment.riderId },
        data: {
          activeDeliveries: { decrement: 1 },
          isAvailable: assignment.rider.status !== 'off_duty' && assignment.rider.status !== 'offline' && currentRemaining < 5,
          status: currentRemaining === 0 ? 'available' : 'on_delivery',
        },
      }),
    );

    const orderDataUpdate: any = {};
    if (assignment.order && (assignment.order as any).status !== 'COMPLETED') {
      orderDataUpdate.status = 'COMPLETED';
      shouldCompleteOrder = true;
    }

    if (paymentMethod && typeof paymentMethod === 'string' && paymentMethod.trim() !== '') {
      const pmTrimmed = paymentMethod.trim();
      const advanceAmount = Number(assignment.order?.advancePayment ?? 0);
      const total = Number(assignment.order?.total ?? 0);
      const remainingCOD = Math.max(0, total - advanceAmount);

      const isPrepaidOrder = (assignment.amountToCollect != null && Number(assignment.amountToCollect) === 0) || (advanceAmount > 0 && advanceAmount >= total);

      if (!isPrepaidOrder) {
        let updatedPaymentMethod: string;
        if (advanceAmount > 0) {
          const existingPM = assignment.order?.paymentMethod || '';
          const advanceMethod = getCashierPaymentMethodString(existingPM); // safe fallback to 'Cash' built in

          updatedPaymentMethod = `Advance (${advanceMethod}: Rs.${advanceAmount}), COD Balance (${pmTrimmed}): Rs.${remainingCOD}`;
        } else {
          updatedPaymentMethod = `COD Balance (${pmTrimmed}): Rs.${remainingCOD}`;
        }

        orderDataUpdate.paymentMethod = updatedPaymentMethod;
      }
    }

    if (Object.keys(orderDataUpdate).length > 0) {
      ops.push(
        prisma.order.update({
          where: { id: assignment.orderId },
          data: orderDataUpdate,
        }),
      );
    }

    if (shouldCompleteOrder && assignment.order) {
      ops.push(
        prisma.reservation.updateMany({
          where: {
            OR: [
              { orderId: assignment.orderId },
              ...(assignment.order.tableNumber ? [{ tableNumber: String(assignment.order.tableNumber), status: 'seated' }] : [])
            ],
            status: { not: 'completed' }
          },
          data: { status: 'completed' }
        })
      );
    }
  }

  if (status === 'returned') {
    const currentRemaining = Math.max(0, (assignment.rider.activeDeliveries || 1) - 1);
    ops.push(
      prisma.deliveryRider.update({
        where: { id: assignment.riderId },
        data: {
          activeDeliveries: { decrement: 1 },
          isAvailable: assignment.rider.status !== 'off_duty' && assignment.rider.status !== 'offline' && currentRemaining < 5,
          status: currentRemaining === 0 ? 'available' : 'on_delivery',
        },
      }),
    );
  }

  const [updated] = await prisma.$transaction(ops);

  if (shouldCompleteOrder && assignment.order) {
    try {
      const fullUpdatedOrder = await prisma.order.findUnique({
        where: { id: assignment.orderId },
        include: { items: true },
      });
      if (fullUpdatedOrder) {
        await runOrderStatusPostEffects(prisma, assignment.order as any, fullUpdatedOrder, 'COMPLETED', req);
      }
    } catch (e) {
      // Non-blocking side effect
    }
  }

  // Emit real-time event so Delivery.tsx updates live
  emitDeliveryEvent('delivery:status_updated', {
    assignmentId: id,
    status,
    riderId: assignment.riderId,
    outletId: assignment.order?.outletId,
  }, [assignment.order?.outletId]);
  res.json(ApiResponse.success(mapAssignment(updated)));
});

/** GET /api/delivery/riders/:id/stats — per-rider daily stats for manager dashboard */
export const getRiderStats = asyncHandler(async (req: Request, res: Response) => {
  const { id } = req.params;
  const { date } = req.query as { date?: string };

  const rider = await prisma.deliveryRider.findUnique({ where: { id }, include: { user: { select: { outletId: true } } } });
  if (!rider) throw ApiError.notFound('Rider not found');
  const scope = resolveOutletScope(req);
  if (scope && rider.user?.outletId !== scope) throw ApiError.notFound('Rider not found');

  const day = date ? new Date(date) : new Date();
  day.setHours(0, 0, 0, 0);
  const dayEnd = new Date(day); dayEnd.setHours(23, 59, 59, 999);

  const todayDelivered = await prisma.deliveryAssignment.findMany({
    where: { riderId: id, status: 'delivered', deliveredAt: { gte: day, lte: dayEnd } },
    include: { order: { select: { total: true, settlementId: true, riderSettlementId: true } } },
  });

  const todaySales     = todayDelivered.reduce((s, a) => s + Number(a.order?.total ?? 0), 0);
  const todayCommissions = todayDelivered.reduce((s, a) => s + Number(a.commissionEarned ?? 0), 0);
  const isCleared      = (a: any) => !!(a.order?.settlementId || a.order?.riderSettlementId);
  const pendingCash   = todayDelivered.filter(a => !isCleared(a)).reduce((s, a) => s + Number(a.amountToCollect ?? a.order?.total ?? 0), 0);
  const collectedCash = todayDelivered.filter(a =>  isCleared(a)).reduce((s, a) => s + Number(a.amountToCollect ?? a.order?.total ?? 0), 0);

  res.json(ApiResponse.success({
    rider: mapRider(rider),
    todayOrders:  todayDelivered.length,
    todaySales,
    todayCommissions,
    pendingCash,
    collectedCash,
  }));
});

/** GET /api/delivery/dashboard — all riders summary for manager */
export const getDeliveryDashboard = asyncHandler(async (req: Request, res: Response) => {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const todayEnd = new Date(today); todayEnd.setHours(23, 59, 59, 999);

  const scope = resolveOutletScope(req);
  const [riders, todayDeliveries, activeAssignments] = await Promise.all([
    prisma.deliveryRider.findMany({ where: scope ? { user: { outletId: scope } } : {}, orderBy: { name: 'asc' } }),
    prisma.deliveryAssignment.findMany({
      where: { status: 'delivered', deliveredAt: { gte: today, lte: todayEnd }, ...(scope ? { order: { outletId: scope } } : {}) },
      include: { order: { select: { total: true, settlementId: true, riderSettlementId: true } } },
    }),
    prisma.deliveryAssignment.findMany({
      where: {
        status: { in: ['pending', 'accepted', 'dispatched'] },
        order: {
          status: { not: 'CANCELLED' },
          ...(scope ? { outletId: scope } : {}),
        },
      },
      include: { order: { select: { id: true, orderNumber: true, total: true, advancePayment: true, paymentMethod: true, customerName: true, deliveryAddress: true, status: true } }, rider: true },
      orderBy: { assignedAt: 'desc' },
    }),
  ]);

  const isCleared = (a: any) => !!(a.order?.settlementId || a.order?.riderSettlementId);
  const riderStats = riders.map(r => {
    const myDeliveries = todayDeliveries.filter(a => a.riderId === r.id);
    const todaySales   = myDeliveries.reduce((s, a) => s + Number(a.order?.total ?? 0), 0);
    const todayCommissions = myDeliveries.reduce((s, a) => s + Number(a.commissionEarned ?? 0), 0);
    const pendingCash  = myDeliveries.filter(a => !isCleared(a)).reduce((s, a) => s + Number(a.amountToCollect ?? a.order?.total ?? 0), 0);
    const collectedCash = myDeliveries.filter(a => isCleared(a)).reduce((s, a) => s + Number(a.amountToCollect ?? a.order?.total ?? 0), 0);
    return { ...mapRider(r), todayOrders: myDeliveries.length, todaySales, todayCommissions, pendingCash, collectedCash };
  });

  res.json(ApiResponse.success({ riderStats, activeAssignments: activeAssignments.map(mapAssignment) }));
});
