/**
 * Deal Controller — CRUD for Deals & Combos.
 *
 * Scoping is a deliberate EXCEPTION to this project's standard outlet-scoping
 * contract (see root CLAUDE.md's "Outlet Scoping" section): a Deal is a
 * pricing overlay on the chain-wide menu catalog (FoodMenuItem/FoodCategory
 * have no outletId either), so it does not use resolveOutletScope's
 * where.outletId shape. Instead `Deal.outletIds: String[]` is an allow-list —
 * empty means "every outlet". Reads filter by membership; writes are gated by
 * role (Manager is pinned to their own outlet, Admin/Super Admin can publish
 * chain-wide). Do not read this module's absence of where.outletId as a
 * scoping leak when auditing against the standard contract.
 */

import type { Request, Response } from 'express';
import { prisma } from '../../config/database.js';
import { ApiResponse } from '../../utils/ApiResponse.js';
import { ApiError } from '../../utils/ApiError.js';
import { asyncHandler } from '../../utils/asyncHandler.js';
import { resolveOutletScope } from '../../middleware/outletScope.js';
import { mapDealOut } from './deal.pricing.js';
import type { DealInput } from './deal.schema.js';

const dealInclude = {
  components: { orderBy: { displayOrder: 'asc' as const } },
  optionGroups: {
    orderBy: { displayOrder: 'asc' as const },
    include: { options: { orderBy: { displayOrder: 'asc' as const } } },
  },
};

/** GET /api/deals */
export const getDeals = asyncHandler(async (req: Request, res: Response) => {
  const includeArchived = req.query.includeArchived === 'true';
  const scope = resolveOutletScope(req);

  const where: any = {};
  if (!includeArchived) where.status = { not: 'archived' };
  if (scope) {
    where.OR = [{ outletIds: { isEmpty: true } }, { outletIds: { has: scope } }];
  }

  const deals = await prisma.deal.findMany({
    where,
    include: dealInclude,
    orderBy: { createdAt: 'desc' },
  });
  res.json(ApiResponse.success(deals.map(mapDealOut)));
});

/** GET /api/deals/:id */
export const getDealById = asyncHandler(async (req: Request, res: Response) => {
  const deal = await prisma.deal.findUnique({ where: { id: req.params.id }, include: dealInclude });
  if (!deal) throw ApiError.notFound('Deal not found');

  const scope = resolveOutletScope(req);
  if (scope && deal.outletIds.length > 0 && !deal.outletIds.includes(scope)) {
    throw ApiError.notFound('Deal not found');
  }
  res.json(ApiResponse.success(mapDealOut(deal)));
});

/** Managers publish only to their own outlet; Admin/Super Admin may publish
 *  chain-wide (empty outletIds) or to any specific list. Returns the outletIds
 *  actually allowed to be persisted for this actor. */
function resolveWritableOutletIds(req: Request, requested: string[]): string[] {
  const role = req.user?.role;
  if (role === 'Super Admin' || role === 'Admin') return requested;

  // Manager: forced to their own outlet, regardless of what was requested.
  const own = req.user?.outletId;
  if (!own) throw ApiError.badRequest('Your account has no assigned outlet');
  return [own];
}

const TYPE_TO_PRISMA: Record<DealInput['type'], string> = {
  combo: 'COMBO',
  option_combo: 'OPTION_COMBO',
  percentage: 'PERCENTAGE',
  buy_x_get_y: 'BUY_X_GET_Y',
};

function buildNestedWrite(body: DealInput) {
  if (body.type === 'combo') {
    return {
      components: {
        create: body.components.map((c, idx) => ({
          menuItemId: c.menuItemId,
          variantId: c.variantId ?? null,
          qty: c.qty,
          displayOrder: c.displayOrder ?? idx,
        })),
      },
    };
  }
  if (body.type === 'option_combo') {
    return {
      optionGroups: {
        create: body.optionGroups.map((g, idx) => ({
          label: g.label,
          minSelections: g.minSelections,
          maxSelections: g.maxSelections,
          displayOrder: g.displayOrder ?? idx,
          options: {
            create: g.options.map((o, oIdx) => ({
              menuItemId: o.menuItemId,
              variantId: o.variantId ?? null,
              extraPrice: o.extraPrice ?? 0,
              displayOrder: o.displayOrder ?? oIdx,
            })),
          },
        })),
      },
    };
  }
  // percentage / buy_x_get_y have no nested components/optionGroups —
  // their contents live entirely in the flat fields below.
  return {};
}

/** Flat fields shared by percentage/buy_x_get_y — nulled out for
 *  combo/option_combo so switching a deal's type on edit cleanly drops the
 *  previous type's fields instead of leaving stale data behind. */
function buildFlatFields(body: DealInput) {
  return {
    price: body.price ?? null,
    discountPercent: body.discountPercent ?? null,
    applicableItems: body.applicableItems ?? [],
    applicableCategories: body.applicableCategories ?? [],
    buyItemId: body.buyItemId ?? null,
    buyQty: body.buyQty ?? null,
    getItemId: body.getItemId ?? null,
    getQty: body.getQty ?? null,
  };
}

/** Sanity check for Fixed Bundles only: the deal price shouldn't exceed the
 *  regular value of its components (Customizable combos are skipped — which
 *  group(s) a customer picks varies, so "the regular total" is ambiguous;
 *  DealForm.tsx's own savings calculator has the same Fixed-Bundle-only scope). */
async function assertPriceBelowRegularValue(body: DealInput) {
  if (body.type !== 'combo' || body.components.length === 0) return;
  const menuItems = await prisma.foodMenuItem.findMany({
    where: { id: { in: body.components.map((c) => c.menuItemId) } },
    include: { variants: true },
  });
  const byId = new Map(menuItems.map((m) => [m.id, m]));
  let regularTotal = 0;
  for (const c of body.components) {
    const menuItem = byId.get(c.menuItemId);
    if (!menuItem) continue;
    const variant = c.variantId ? menuItem.variants.find((v) => v.id === c.variantId) : undefined;
    const unitPrice = Number(variant?.price ?? menuItem.price);
    regularTotal += unitPrice * c.qty;
  }
  if (regularTotal > 0 && body.price != null && body.price > regularTotal) {
    throw ApiError.badRequest(
      `Deal price (${body.price}) cannot exceed the regular value of its included items (${regularTotal})`
    );
  }
}

/** POST /api/deals */
export const createDeal = asyncHandler(async (req: Request, res: Response) => {
  const body = req.body as DealInput;
  await assertPriceBelowRegularValue(body);
  const outletIds = resolveWritableOutletIds(req, body.outletIds);

  try {
    const deal = await prisma.deal.create({
      data: {
        name: body.name,
        code: body.code || null,
        description: body.description || null,
        image: body.image || null,
        type: TYPE_TO_PRISMA[body.type] as any,
        ...buildFlatFields(body),
        dineInPrice: body.dineInPrice ?? null,
        takeAwayPrice: body.takeAwayPrice ?? null,
        deliveryPrice: body.deliveryPrice ?? null,
        foodpandaPrice: body.foodpandaPrice ?? null,
        isActive: body.isActive ?? true,
        outletIds,
        validFrom: body.validFrom,
        validTo: body.validTo ?? null,
        startTime: body.startTime ?? null,
        endTime: body.endTime ?? null,
        ...buildNestedWrite(body),
      },
      include: dealInclude,
    });
    res.status(201).json(ApiResponse.created(mapDealOut(deal), 'Deal created'));
  } catch (err: any) {
    if (err?.code === 'P2002') throw ApiError.badRequest('A deal with this code already exists');
    throw err;
  }
});

/** PUT /api/deals/:id — full replace (components/optionGroups deleted + recreated). */
export const updateDeal = asyncHandler(async (req: Request, res: Response) => {
  const { id } = req.params;
  const existing = await prisma.deal.findUnique({ where: { id } });
  if (!existing) throw ApiError.notFound('Deal not found');

  const role = req.user?.role;
  if (role !== 'Super Admin' && role !== 'Admin') {
    const own = req.user?.outletId;
    const existingIsChainWide = existing.outletIds.length === 0;
    const existingIsOwnOnly = existing.outletIds.length === 1 && existing.outletIds[0] === own;
    if (existingIsChainWide || !existingIsOwnOnly) {
      throw ApiError.forbidden('Only Admin/Super Admin can edit a chain-wide deal, or a deal outside your outlet');
    }
  }

  const body = req.body as DealInput;
  await assertPriceBelowRegularValue(body);
  const outletIds = resolveWritableOutletIds(req, body.outletIds);

  try {
    const deal = await prisma.$transaction(async (tx) => {
      await tx.dealComponent.deleteMany({ where: { dealId: id } });
      await tx.dealOptionGroup.deleteMany({ where: { dealId: id } }); // cascades to DealOptionItem

      return tx.deal.update({
        where: { id },
        data: {
          name: body.name,
          code: body.code || null,
          description: body.description || null,
          image: body.image || null,
          type: TYPE_TO_PRISMA[body.type] as any,
          ...buildFlatFields(body),
          dineInPrice: body.dineInPrice ?? null,
          takeAwayPrice: body.takeAwayPrice ?? null,
          deliveryPrice: body.deliveryPrice ?? null,
          foodpandaPrice: body.foodpandaPrice ?? null,
          isActive: body.isActive ?? true,
          outletIds,
          validFrom: body.validFrom,
          validTo: body.validTo ?? null,
          startTime: body.startTime ?? null,
          endTime: body.endTime ?? null,
          ...buildNestedWrite(body),
        },
        include: dealInclude,
      });
    });
    res.json(ApiResponse.success(mapDealOut(deal), 'Deal updated'));
  } catch (err: any) {
    if (err?.code === 'P2002') throw ApiError.badRequest('A deal with this code already exists');
    throw err;
  }
});

/** PATCH /api/deals/:id/toggle */
export const toggleDeal = asyncHandler(async (req: Request, res: Response) => {
  const { id } = req.params;
  const existing = await prisma.deal.findUnique({ where: { id } });
  if (!existing) throw ApiError.notFound('Deal not found');

  const deal = await prisma.deal.update({
    where: { id },
    data: { isActive: !existing.isActive },
    include: dealInclude,
  });
  res.json(ApiResponse.success(mapDealOut(deal), deal.isActive ? 'Deal activated' : 'Deal deactivated'));
});

/** DELETE /api/deals/:id — archives if the deal has sale history (preserves
 *  OrderItem.dealId/dealName for historical receipts/reports), otherwise hard-deletes. */
export const deleteDeal = asyncHandler(async (req: Request, res: Response) => {
  const { id } = req.params;
  const existing = await prisma.deal.findUnique({ where: { id } });
  if (!existing) throw ApiError.notFound('Deal not found');

  const soldCount = await prisma.orderItem.count({ where: { dealId: id } });
  if (soldCount > 0) {
    await prisma.deal.update({ where: { id }, data: { status: 'archived', isActive: false } });
    res.json(ApiResponse.success(null, `Deal archived (it has ${soldCount} past sale${soldCount > 1 ? 's' : ''})`));
    return;
  }

  await prisma.deal.delete({ where: { id } }); // cascades to components/optionGroups/options
  res.json(ApiResponse.success(null, 'Deal deleted'));
});
