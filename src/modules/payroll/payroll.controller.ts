import type { Request, Response } from 'express';
import { prisma } from '../../config/database.js';
import { ApiResponse } from '../../utils/ApiResponse.js';
import { ApiError } from '../../utils/ApiError.js';
import { asyncHandler } from '../../utils/asyncHandler.js';

function mapPaymentLog(log: any) {
  const isAdvanceFlag = Boolean(
    log.isAdvance || (log.notes && typeof log.notes === 'string' && log.notes.startsWith('Salary Advance'))
  );
  return {
    ...log,
    basePay: Number(log.basePay),
    penalties: Number(log.penalties),
    rewards: Number(log.rewards),
    finalPay: Number(log.finalPay),
    advanceAmount: Number(log.advanceAmount || 0),
    isAdvance: isAdvanceFlag,
    rate: log.rate != null ? Number(log.rate) : null,
    unitsWorked: log.unitsWorked != null ? Number(log.unitsWorked) : null,
    completedDeliveries: Number(log.completedDeliveries ?? 0),
    totalDeliveryCommissions: Number(log.totalDeliveryCommissions ?? 0),
  };
}

export const createPaymentLog = asyncHandler(async (req: Request, res: Response) => {
  const {
    employeeId, startDate, endDate, basePay, penalties, rewards, finalPay, notes,
    rateType, rate, unitsWorked, absentDays, penaltyIds, advanceAmount, isAdvance,
    completedDeliveries, totalDeliveryCommissions,
  } = req.body;
  const paidById = req.user?.id;

  if (!employeeId || !startDate || !endDate || basePay == null || penalties == null || rewards == null || finalPay == null) {
    throw new ApiError('Missing required payment fields', 400);
  }

  if (!paidById) {
    throw new ApiError('Not authenticated', 401);
  }

  const isAdvanceFlag = Boolean(isAdvance || (notes && typeof notes === 'string' && notes.startsWith('Salary Advance')));

  // Duplicate check using raw SQL to avoid any Prisma ORM operator ambiguity.
  // Advance (isAdvance=true) and regular salary (isAdvance=false) are independent —
  // one of each is allowed per employee per period.
  if (isAdvanceFlag) {
    // Block a second advance for the same period
    const dupRows: any[] = await prisma.$queryRaw`
      SELECT id FROM payment_logs
      WHERE "employeeId" = ${employeeId}
        AND "startDate" = ${startDate}
        AND "endDate"   = ${endDate}
        AND ("isAdvance" = true OR notes LIKE 'Salary Advance%')
      LIMIT 1
    `;
    if (dupRows.length > 0) {
      throw new ApiError('An advance payment has already been issued for this period', 409);
    }
  } else {
    // Block a second regular salary payout for the same month window
    const dupRows: any[] = await prisma.$queryRaw`
      SELECT id FROM payment_logs
      WHERE "employeeId" = ${employeeId}
        AND "isAdvance" = false
        AND notes NOT LIKE 'Salary Advance%'
        AND "startDate" >= ${startDate}
        AND "startDate" <= ${endDate}
      LIMIT 1
    `;
    if (dupRows.length > 0) {
      throw new ApiError('This employee has already been paid for this period', 409);
    }
  }

  const log = await prisma.$transaction(async (tx) => {
    const created = await tx.paymentLog.create({
      data: {
        employeeId,
        startDate,
        endDate,
        basePay,
        penalties,
        rewards,
        finalPay,
        notes,
        paidById,
        rateType,
        rate,
        unitsWorked,
        absentDays,
        advanceAmount: advanceAmount || 0,
        isAdvance: isAdvanceFlag,
        completedDeliveries: completedDeliveries ?? 0,
        totalDeliveryCommissions: totalDeliveryCommissions ?? 0,
      },
      include: {
        employee: {
          select: {
            firstName: true,
            lastName: true,
            designation: true,
          },
        },
        paidBy: {
          select: {
            name: true,
          },
        },
      },
    });

    // Mark the StaffPenalty (order-cancellation penalty) rows folded into this payout
    // as paid, so the next payroll run never counts them again.
    if (Array.isArray(penaltyIds) && penaltyIds.length > 0) {
      await tx.staffPenalty.updateMany({
        where: { id: { in: penaltyIds }, paymentLogId: null },
        data: { paymentLogId: created.id },
      });
    }

    return created;
  });

  return res.status(201).json(ApiResponse.created(mapPaymentLog(log), 'Payment logged successfully'));
});

export const createBatchPaymentLogs = asyncHandler(async (req: Request, res: Response) => {
  const { payments } = req.body; // array of payment records
  const paidById = req.user?.id;

  if (!paidById) {
    throw new ApiError('Not authenticated', 401);
  }

  if (!Array.isArray(payments) || payments.length === 0) {
    throw new ApiError('Invalid or empty payments array', 400);
  }

  // Skip any employee/period combination already paid (non-advance).
  // Use raw SQL to avoid Prisma ORM ambiguity with isAdvance + NOT combinations.
  const alreadyPaidKeys = new Set<string>();
  for (const p of payments) {
    const dupRows: any[] = await prisma.$queryRaw`
      SELECT id FROM payment_logs
      WHERE "employeeId" = ${p.employeeId}
        AND "isAdvance" = false
        AND notes NOT LIKE 'Salary Advance%'
        AND "startDate" >= ${p.startDate}
        AND "startDate" <= ${p.endDate}
      LIMIT 1
    `;
    if (dupRows.length > 0) {
      alreadyPaidKeys.add(`${p.employeeId}|${p.startDate}|${p.endDate}`);
    }
  }
  const toPay = payments.filter((p: any) => !alreadyPaidKeys.has(`${p.employeeId}|${p.startDate}|${p.endDate}`));
  const skipped = payments.length - toPay.length;

  if (toPay.length === 0) {
    throw new ApiError('All selected employees have already been paid for this period', 409);
  }

  // Interactive transaction (not the array form) so each created log's id is available
  // to stamp its own StaffPenalty rows before moving to the next payout.
  const logs = await prisma.$transaction(async (tx) => {
    const created = [];
    for (const p of toPay) {
      const log = await tx.paymentLog.create({
        data: {
          employeeId: p.employeeId,
          startDate: p.startDate,
          endDate: p.endDate,
          basePay: p.basePay,
          penalties: p.penalties,
          rewards: p.rewards,
          finalPay: p.finalPay,
          notes: p.notes || '',
          paidById,
          rateType: p.rateType,
          rate: p.rate,
          unitsWorked: p.unitsWorked,
          absentDays: p.absentDays,
          advanceAmount: p.advanceAmount || 0,
          isAdvance: Boolean(p.isAdvance || (p.notes && typeof p.notes === 'string' && p.notes.startsWith('Salary Advance'))),
          completedDeliveries: p.completedDeliveries ?? 0,
          totalDeliveryCommissions: p.totalDeliveryCommissions ?? 0,
        },
      });
      if (Array.isArray(p.penaltyIds) && p.penaltyIds.length > 0) {
        await tx.staffPenalty.updateMany({
          where: { id: { in: p.penaltyIds }, paymentLogId: null },
          data: { paymentLogId: log.id },
        });
      }
      created.push(log);
    }
    return created;
  });

  const message = skipped > 0
    ? `${logs.length} payments logged successfully (${skipped} skipped — already paid for this period)`
    : `${logs.length} payments logged successfully`;
  return res.status(201).json(ApiResponse.created(logs.map(mapPaymentLog), message));
});

export const getPaymentLogs = asyncHandler(async (req: Request, res: Response) => {
  const { startDate, endDate, employeeId } = req.query as Record<string, string>;

  const where: any = {};
  if (employeeId) where.employeeId = employeeId;
  if (startDate && endDate) {
    const endDateTime = new Date(`${endDate}T23:59:59.999Z`);
    const startDateTime = new Date(`${startDate}T00:00:00.000Z`);
    where.OR = [
      { startDate: { gte: startDate, lte: endDate } },
      { endDate: { gte: startDate, lte: endDate } },
      { paidAt: { gte: startDateTime, lte: endDateTime } },
    ];
  } else {
    if (startDate) where.startDate = { gte: startDate };
    if (endDate) where.endDate = { lte: endDate };
  }

  const logs = await prisma.paymentLog.findMany({
    where,
    orderBy: { paidAt: 'desc' },
    include: {
      employee: {
        select: {
          firstName: true,
          lastName: true,
          designation: true,
        },
      },
      paidBy: {
        select: {
          name: true,
        },
      },
    },
  });

  return res.json(ApiResponse.success(logs.map(mapPaymentLog)));
});

export const calculateDeliveryCommissions = asyncHandler(async (req: Request, res: Response) => {
  const { employeeId, startDate, endDate } = req.query as Record<string, string>;
  if (!employeeId || !startDate || !endDate) {
    throw new ApiError('employeeId, startDate, and endDate are required', 400);
  }

  // Find the Employee's linked User, then their DeliveryRider record
  const employee = await prisma.employee.findUnique({
    where: { id: employeeId },
    select: { userId: true, commissionPerDelivery: true },
  });
  if (!employee) throw new ApiError('Employee not found', 404);

  const rider = employee.userId
    ? await prisma.deliveryRider.findFirst({ where: { userId: employee.userId } })
    : null;

  if (!rider) {
    return res.json(ApiResponse.success({
      completedDeliveries: 0,
      commissionRate: Number(employee.commissionPerDelivery ?? 0),
      totalDeliveryCommissions: 0,
    }));
  }

  // Count delivered assignments in the date window using deliveredAt
  const assignments = await prisma.deliveryAssignment.findMany({
    where: {
      riderId: rider.id,
      status: 'delivered',
      deliveredAt: {
        gte: new Date(`${startDate}T00:00:00.000Z`),
        lte: new Date(`${endDate}T23:59:59.999Z`),
      },
    },
    select: { commissionEarned: true },
  });

  const completedDeliveries = assignments.length;
  const totalDeliveryCommissions = assignments.reduce(
    (sum, a) => sum + Number(a.commissionEarned ?? 0), 0
  );

  return res.json(ApiResponse.success({
    completedDeliveries,
    commissionRate: Number(employee.commissionPerDelivery ?? 0),
    totalDeliveryCommissions,
  }));
});
