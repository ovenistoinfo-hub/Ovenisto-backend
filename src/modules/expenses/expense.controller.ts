/**
 * Expense Controller — Phase 7
 */
import type { Request, Response } from 'express';
import { prisma } from '../../config/database.js';
import { ApiResponse } from '../../utils/ApiResponse.js';
import { ApiError } from '../../utils/ApiError.js';
import { asyncHandler } from '../../utils/asyncHandler.js';
import { resolveOutletScope, resolveCreateOutlet } from '../../middleware/outletScope.js';

function mapExpense(e: any) {
  return {
    ...e,
    amount: Number(e.amount),
  };
}

export const getExpenses = asyncHandler(async (req: Request, res: Response) => {
  const { page = '1', limit = '20', category, search } = req.query as Record<string, string>;
  const skip = (Number(page) - 1) * Number(limit);

  const where: any = {};
  if (category) where.category = category;
  if (search) {
    where.description = { contains: search, mode: 'insensitive' };
  }

  const scope = resolveOutletScope(req);
  if (scope) where.outletId = scope;

  const [data, total, aggregate] = await Promise.all([
    prisma.expense.findMany({
      where,
      skip,
      take: Number(limit),
      orderBy: { date: 'desc' },
    }),
    prisma.expense.count({ where }),
    prisma.expense.aggregate({ where, _sum: { amount: true } }),
  ]);

  const paginated = ApiResponse.paginated(data.map(mapExpense), Number(page), Number(limit), total);
  return res.json({ ...paginated, totalAmount: Number(aggregate._sum.amount ?? 0) });
});

export const getExpense = asyncHandler(async (req: Request, res: Response) => {
  const e = await prisma.expense.findUnique({ where: { id: req.params.id } });
  if (!e) throw new ApiError('Expense not found', 404);
  const scope = resolveOutletScope(req);
  if (scope && e.outletId !== scope) throw new ApiError('Expense not found', 404);
  return res.json(ApiResponse.success(mapExpense(e)));
});

export const createExpense = asyncHandler(async (req: Request, res: Response) => {
  const { category, description, amount, paymentMethod, reference, receipt, date } = req.body;
  if (!description) throw new ApiError('Description is required', 400);
  if (amount == null) throw new ApiError('Amount is required', 400);

  const recordedBy = req.user?.name || req.user?.email || null;
  const outletId = resolveCreateOutlet(req);

  const e = await prisma.expense.create({
    data: {
      category: category || null,
      description,
      amount: Number(amount),
      paymentMethod: paymentMethod || null,
      reference: reference || null,
      receipt: receipt ?? false,
      date: date ? new Date(date) : new Date(),
      recordedBy,
      outletId,
    },
  });

  return res.status(201).json(ApiResponse.created(mapExpense(e), 'Expense created'));
});

export const updateExpense = asyncHandler(async (req: Request, res: Response) => {
  const existing = await prisma.expense.findUnique({ where: { id: req.params.id } });
  if (!existing) throw new ApiError('Expense not found', 404);
  const scope = resolveOutletScope(req);
  if (scope && existing.outletId !== scope) throw new ApiError('Expense not found', 404);

  const { category, description, amount, paymentMethod, reference, receipt, date } = req.body;

  const e = await prisma.expense.update({
    where: { id: req.params.id },
    data: {
      category: category !== undefined ? category : existing.category,
      description: description !== undefined ? description : existing.description,
      amount: amount != null ? Number(amount) : existing.amount,
      paymentMethod: paymentMethod !== undefined ? paymentMethod : existing.paymentMethod,
      reference: reference !== undefined ? reference : existing.reference,
      receipt: receipt !== undefined ? receipt : existing.receipt,
      date: date ? new Date(date) : existing.date,
    },
  });

  return res.json(ApiResponse.success(mapExpense(e), 'Expense updated'));
});

export const deleteExpense = asyncHandler(async (req: Request, res: Response) => {
  const existing = await prisma.expense.findUnique({ where: { id: req.params.id } });
  if (!existing) throw new ApiError('Expense not found', 404);
  const scope = resolveOutletScope(req);
  if (scope && existing.outletId !== scope) throw new ApiError('Expense not found', 404);
  await prisma.expense.delete({ where: { id: req.params.id } });
  return res.json(ApiResponse.success(null, 'Expense deleted'));
});
