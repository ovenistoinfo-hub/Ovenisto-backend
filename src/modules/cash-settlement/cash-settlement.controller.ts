import type { Request, Response } from 'express';
import { asyncHandler } from '../../utils/asyncHandler.js';
import { ApiResponse } from '../../utils/ApiResponse.js';
import { ApiError } from '../../utils/ApiError.js';
import { resolveOutletScope } from '../../middleware/outletScope.js';
import { prisma } from '../../config/database.js';
import {
  getActiveBalances,
  getStaffActiveBalance,
  createSettlement,
  getSettlementHistory,
} from './cash-settlement.service.js';

const managerRoles = ['Super Admin', 'Admin', 'Manager', 'Floor Manager', 'Delivery Manager'];

export const getActiveBalancesController = asyncHandler(async (req: Request, res: Response) => {
  const scope = resolveOutletScope(req);
  const balances = await getActiveBalances(scope);
  return res.json(ApiResponse.success(balances));
});

export const getStaffActiveBalanceController = asyncHandler(async (req: Request, res: Response) => {
  const scope = resolveOutletScope(req);
  const { staffId } = req.params;
  if (!req.user) {
    throw ApiError.unauthorized('User not authenticated');
  }
  // Non-managers may only look up their own balance (this route has no authorize()
  // middleware so riders/waiters/cashiers can self-query it from their own portal).
  if (!managerRoles.includes(req.user.role as string) && staffId !== req.user.id) {
    throw ApiError.forbidden('You can only view your own cash balance');
  }
  const balance = await getStaffActiveBalance(staffId, scope);
  return res.json(ApiResponse.success(balance));
});

export const createSettlementController = asyncHandler(async (req: Request, res: Response) => {
  const scope = resolveOutletScope(req);
  if (!req.user) {
    throw ApiError.unauthorized('User not authenticated');
  }
  const settlement = await createSettlement(req.user, req.body, scope);
  return res.status(201).json(ApiResponse.created(settlement, 'Cash settlement created successfully'));
});

export const getSettlementHistoryController = asyncHandler(async (req: Request, res: Response) => {
  const scope = resolveOutletScope(req);
  if (!req.user) {
    throw ApiError.unauthorized('User not authenticated');
  }

  let { staffId, role, page, limit, date } = req.query as Record<string, string>;

  // Non-managers may only view their own settlement history
  if (!managerRoles.includes(req.user.role as string)) {
    if (staffId && staffId !== req.user.id) {
      const rider = await prisma.deliveryRider.findFirst({
        where: { userId: req.user.id },
      });
      if (!rider || rider.id !== staffId) {
        throw ApiError.forbidden('You can only view your own settlement history');
      }
    } else {
      staffId = req.user.id;
    }
  }

  const history = await getSettlementHistory(scope, {
    staffId,
    role,
    page: page ? Number(page) : undefined,
    limit: limit ? Number(limit) : undefined,
    date,
  });
  return res.json(
    ApiResponse.paginated(
      history.data,
      history.page,
      history.limit,
      history.total
    )
  );
});

