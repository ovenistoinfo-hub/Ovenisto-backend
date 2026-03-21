/**
 * Delivery / Rider Controller
 */
import type { Request, Response } from 'express';
import { prisma } from '../../config/database.js';
import { ApiResponse } from '../../utils/ApiResponse.js';
import { ApiError } from '../../utils/ApiError.js';
import { asyncHandler } from '../../utils/asyncHandler.js';

function mapRider(r: any) {
  return { ...r, activeDeliveries: Number(r.activeDeliveries ?? 0) };
}

function mapAssignment(a: any) {
  return {
    ...a,
    amountToCollect: a.amountToCollect != null ? Number(a.amountToCollect) : null,
    order: a.order ? {
      ...a.order,
      total:    Number(a.order.total ?? 0),
      subtotal: Number(a.order.subtotal ?? 0),
      tax:      Number(a.order.tax ?? 0),
      discount: Number(a.order.discount ?? 0),
    } : undefined,
    rider: a.rider ? mapRider(a.rider) : undefined,
  };
}

// ─── Rider CRUD ──────────────────────────────────────────────────────────────

/** GET /api/delivery/riders — derived from Users with role=Rider */
export const getRiders = asyncHandler(async (_req: Request, res: Response) => {
  // Pull users with Rider role and join their DeliveryRider profile
  const riderUsers = await prisma.user.findMany({
    where: { role: 'RIDER' as any, status: 'active' },
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
  const rider = await prisma.deliveryRider.findUnique({ where: { id } });
  if (!rider) throw ApiError.notFound('Rider not found');

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

  const assignments = await prisma.deliveryAssignment.findMany({
    where,
    include: {
      order: { select: { id: true, orderNumber: true, total: true, subtotal: true, tax: true, discount: true, status: true, customer: true, deliveryAddress: true, phone: true } },
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
    where: { riderId: riderProfile.id, status: { in: ['pending', 'accepted', 'dispatched'] } },
    include: { order: { select: { id: true, orderNumber: true, total: true, customer: true, deliveryAddress: true, phone: true } } },
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

  const todaySales   = todayAssignments.reduce((s, a) => s + Number(a.order?.total ?? 0), 0);
  const totalSales   = allAssignments.reduce((s, a)   => s + Number(a.order?.total ?? 0), 0);
  const pendingCash  = todayAssignments.filter(a => !a.collectedAt).reduce((s, a) => s + Number(a.amountToCollect ?? a.order?.total ?? 0), 0);

  res.json(ApiResponse.success({
    rider: mapRider(riderProfile),
    todayOrders:  todayAssignments.length,
    todaySales,
    totalOrders:  allAssignments.length,
    totalSales,
    pendingCash,
  }));
});

/** POST /api/delivery/assign */
export const assignRider = asyncHandler(async (req: Request, res: Response) => {
  const { orderId, riderId, estimatedTime, notes } = req.body;
  if (!orderId || !riderId) throw ApiError.badRequest('orderId and riderId are required');

  const [order, rider] = await Promise.all([
    prisma.order.findUnique({ where: { id: orderId } }),
    prisma.deliveryRider.findUnique({ where: { id: riderId } }),
  ]);
  if (!order)  throw ApiError.notFound('Order not found');
  if (!rider)  throw ApiError.notFound('Rider not found');
  if (!rider.isAvailable) throw ApiError.badRequest('Rider is not available');

  const existing = await prisma.deliveryAssignment.findFirst({ where: { orderId, status: { notIn: ['returned'] } } });
  if (existing) throw ApiError.badRequest('Order already has an active assignment');

  const [assignment] = await prisma.$transaction([
    prisma.deliveryAssignment.create({
      data: {
        orderId, riderId,
        status: 'pending',
        estimatedTime:   estimatedTime || 30,
        customerAddress: order.deliveryAddress || '',
        customerPhone:   order.phone || '',
        amountToCollect: order.total,
        notes: notes || null,
      },
      include: { order: { select: { id: true, orderNumber: true, total: true, customer: true, deliveryAddress: true } }, rider: true },
    }),
    prisma.deliveryRider.update({
      where: { id: riderId },
      data: { activeDeliveries: { increment: 1 }, isAvailable: false, status: 'on_delivery' },
    }),
    prisma.order.update({ where: { id: orderId }, data: { riderId } }),
  ]);

  res.status(201).json(ApiResponse.created(mapAssignment(assignment), 'Rider assigned'));
});

/** PUT /api/delivery/assignments/:id/status */
export const updateAssignmentStatus = asyncHandler(async (req: Request, res: Response) => {
  const { id } = req.params;
  const { status } = req.body;

  const allowed = ['accepted', 'dispatched', 'delivered', 'returned'];
  if (!allowed.includes(status)) throw ApiError.badRequest(`Status must be one of: ${allowed.join(', ')}`);

  const assignment = await prisma.deliveryAssignment.findUnique({ where: { id }, include: { rider: true } });
  if (!assignment) throw ApiError.notFound('Assignment not found');

  const data: any = { status };
  if (status === 'accepted')   data.acceptedAt   = new Date();
  if (status === 'delivered')  data.deliveredAt  = new Date();

  const ops: any[] = [prisma.deliveryAssignment.update({ where: { id }, data, include: { order: { select: { id: true, orderNumber: true, total: true, customer: true } }, rider: true } })];

  // When delivered — decrement active deliveries, restore availability, complete order
  if (status === 'delivered') {
    ops.push(
      prisma.deliveryRider.update({
        where: { id: assignment.riderId },
        data: { activeDeliveries: { decrement: 1 }, isAvailable: true, status: 'available' },
      }),
      prisma.order.update({ where: { id: assignment.orderId }, data: { status: 'COMPLETED' as any } }),
    );
  }
  if (status === 'returned') {
    ops.push(
      prisma.deliveryRider.update({
        where: { id: assignment.riderId },
        data: { activeDeliveries: { decrement: 1 }, isAvailable: true, status: 'available' },
      }),
    );
  }

  const [updated] = await prisma.$transaction(ops);
  res.json(ApiResponse.success(mapAssignment(updated)));
});

/** PUT /api/delivery/assignments/:id/collect — manager collects cash from rider */
export const collectAmount = asyncHandler(async (req: Request, res: Response) => {
  const { id } = req.params;
  const assignment = await prisma.deliveryAssignment.findUnique({ where: { id } });
  if (!assignment) throw ApiError.notFound('Assignment not found');
  if (assignment.status !== 'delivered') throw ApiError.badRequest('Can only collect from delivered orders');
  if (assignment.collectedAt) throw ApiError.badRequest('Amount already collected');

  const updated = await prisma.deliveryAssignment.update({
    where: { id },
    data: { collectedAt: new Date(), collectedBy: req.user?.name || 'Manager' },
    include: { order: { select: { id: true, orderNumber: true, total: true } }, rider: true },
  });
  res.json(ApiResponse.success(mapAssignment(updated), 'Amount collected'));
});

/** GET /api/delivery/riders/:id/stats — per-rider daily stats for manager dashboard */
export const getRiderStats = asyncHandler(async (req: Request, res: Response) => {
  const { id } = req.params;
  const { date } = req.query as { date?: string };

  const rider = await prisma.deliveryRider.findUnique({ where: { id } });
  if (!rider) throw ApiError.notFound('Rider not found');

  const day = date ? new Date(date) : new Date();
  day.setHours(0, 0, 0, 0);
  const dayEnd = new Date(day); dayEnd.setHours(23, 59, 59, 999);

  const todayDelivered = await prisma.deliveryAssignment.findMany({
    where: { riderId: id, status: 'delivered', deliveredAt: { gte: day, lte: dayEnd } },
    include: { order: { select: { total: true } } },
  });

  const todaySales    = todayDelivered.reduce((s, a) => s + Number(a.order?.total ?? 0), 0);
  const pendingCash   = todayDelivered.filter(a => !a.collectedAt).reduce((s, a) => s + Number(a.amountToCollect ?? a.order?.total ?? 0), 0);
  const collectedCash = todayDelivered.filter(a =>  a.collectedAt).reduce((s, a) => s + Number(a.amountToCollect ?? a.order?.total ?? 0), 0);

  res.json(ApiResponse.success({
    rider: mapRider(rider),
    todayOrders:  todayDelivered.length,
    todaySales,
    pendingCash,
    collectedCash,
  }));
});

/** GET /api/delivery/dashboard — all riders summary for manager */
export const getDeliveryDashboard = asyncHandler(async (_req: Request, res: Response) => {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const todayEnd = new Date(today); todayEnd.setHours(23, 59, 59, 999);

  const [riders, todayDeliveries, activeAssignments] = await Promise.all([
    prisma.deliveryRider.findMany({ orderBy: { name: 'asc' } }),
    prisma.deliveryAssignment.findMany({
      where: { status: 'delivered', deliveredAt: { gte: today, lte: todayEnd } },
      include: { order: { select: { total: true } } },
    }),
    prisma.deliveryAssignment.findMany({
      where: { status: { in: ['pending', 'accepted', 'dispatched'] } },
      include: { order: { select: { id: true, orderNumber: true, total: true, customer: true, deliveryAddress: true } }, rider: true },
      orderBy: { assignedAt: 'desc' },
    }),
  ]);

  const riderStats = riders.map(r => {
    const myDeliveries = todayDeliveries.filter(a => a.riderId === r.id);
    const todaySales   = myDeliveries.reduce((s, a) => s + Number(a.order?.total ?? 0), 0);
    const pendingCash  = myDeliveries.filter(a => !a.collectedAt).reduce((s, a) => s + Number(a.amountToCollect ?? a.order?.total ?? 0), 0);
    const collectedCash = myDeliveries.filter(a => a.collectedAt).reduce((s, a) => s + Number(a.amountToCollect ?? a.order?.total ?? 0), 0);
    return { ...mapRider(r), todayOrders: myDeliveries.length, todaySales, pendingCash, collectedCash };
  });

  res.json(ApiResponse.success({ riderStats, activeAssignments: activeAssignments.map(mapAssignment) }));
});
