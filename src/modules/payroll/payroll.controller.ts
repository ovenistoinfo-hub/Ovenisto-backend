import type { Request, Response } from 'express';
import { prisma } from '../../config/database.js';
import { ApiResponse } from '../../utils/ApiResponse.js';
import { ApiError } from '../../utils/ApiError.js';
import { asyncHandler } from '../../utils/asyncHandler.js';

function mapPaymentLog(log: any) {
  return {
    ...log,
    basePay: Number(log.basePay),
    penalties: Number(log.penalties),
    rewards: Number(log.rewards),
    finalPay: Number(log.finalPay),
    rate: log.rate != null ? Number(log.rate) : null,
    unitsWorked: log.unitsWorked != null ? Number(log.unitsWorked) : null,
  };
}

export const createPaymentLog = asyncHandler(async (req: Request, res: Response) => {
  const {
    employeeId, startDate, endDate, basePay, penalties, rewards, finalPay, notes,
    rateType, rate, unitsWorked, absentDays, penaltyIds,
  } = req.body;
  const paidById = req.user?.id;

  if (!employeeId || !startDate || !endDate || basePay == null || penalties == null || rewards == null || finalPay == null) {
    throw new ApiError('Missing required payment fields', 400);
  }

  if (!paidById) {
    throw new ApiError('Not authenticated', 401);
  }

  const existing = await prisma.paymentLog.findUnique({
    where: { employeeId_startDate_endDate: { employeeId, startDate, endDate } },
  });
  if (existing) {
    throw new ApiError('This employee has already been paid for this period', 409);
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

  // Skip any employee/period combination already paid, rather than letting one
  // conflict abort the whole batch transaction.
  const existingLogs = await prisma.paymentLog.findMany({
    where: {
      OR: payments.map((p: any) => ({
        employeeId: p.employeeId,
        startDate: p.startDate,
        endDate: p.endDate,
      })),
    },
    select: { employeeId: true, startDate: true, endDate: true },
  });
  const alreadyPaidKeys = new Set(existingLogs.map((l) => `${l.employeeId}|${l.startDate}|${l.endDate}`));
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
  if (startDate) where.startDate = { gte: startDate };
  if (endDate) where.endDate = { lte: endDate };

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
