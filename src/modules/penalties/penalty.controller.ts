import type { Request, Response } from 'express';
import { prisma } from '../../config/database.js';
import { ApiResponse } from '../../utils/ApiResponse.js';
import { asyncHandler } from '../../utils/asyncHandler.js';

function mapPenalty(p: any) {
  return { ...p, amount: Number(p.amount) };
}

/** GET /api/penalties/mine — the authenticated user's own penalty history (My Portal). */
export const getMyPenalties = asyncHandler(async (req: Request, res: Response) => {
  const penalties = await prisma.staffPenalty.findMany({
    where: { userId: req.user!.id },
    orderBy: { date: 'desc' },
  });
  res.json(ApiResponse.success(penalties.map(mapPenalty)));
});

/**
 * GET /api/penalties — chain-wide list for Payroll, matching Payroll's existing
 * unscoped attendance/payment-log queries (see CLAUDE.md: Payroll/PaymentLog was
 * built after the outlet-scoping rollout and was never scoped).
 */
export const getPenalties = asyncHandler(async (req: Request, res: Response) => {
  const { userId, startDate, endDate, unpaidOnly } = req.query as Record<string, string>;

  const where: Record<string, unknown> = {};
  if (userId) where.userId = userId;
  if (startDate || endDate) {
    where.date = {
      ...(startDate ? { gte: startDate } : {}),
      ...(endDate ? { lte: endDate } : {}),
    };
  }
  if (unpaidOnly === '1' || unpaidOnly === 'true') where.paymentLogId = null;

  const penalties = await prisma.staffPenalty.findMany({
    where,
    include: { user: { select: { id: true, name: true } } },
    orderBy: { date: 'desc' },
  });

  res.json(ApiResponse.success(penalties.map(mapPenalty)));
});
