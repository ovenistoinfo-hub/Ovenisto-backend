import type { Request, Response } from 'express';
import { prisma } from '../../config/database.js';
import { ApiResponse } from '../../utils/ApiResponse.js';
import { ApiError } from '../../utils/ApiError.js';
import { asyncHandler } from '../../utils/asyncHandler.js';
import { buildPublicMenu } from '../menu/publicMenu.js';
import {
  WEBSITE_ORDER_TYPES,
  parseWebsiteOrderType,
  readWebsiteConfig,
  isAcceptingOrders,
} from './website.helpers.js';
import { isDealCurrentlyValid, isDealAvailableForChannel, mapDealOutPublic } from '../deals/deal.pricing.js';

async function getActiveOutlet(outletId: unknown) {
  if (typeof outletId !== 'string') throw ApiError.badRequest('outletId is required');
  const outlet = await prisma.outlet.findUnique({ where: { id: outletId } });
  if (!outlet || !outlet.isActive) throw ApiError.notFound('Outlet not found');
  return outlet;
}

async function getOutletSettings(outletId: string) {
  const specific = await prisma.settings.findFirst({ where: { outletId } });
  if (specific) return specific;
  const fallback = await prisma.settings.findFirst({ where: { outletId: null } });
  return fallback;
}

export const getOutlets = asyncHandler(async (req: Request, res: Response) => {
  const outlets = await prisma.outlet.findMany({
    where: { isActive: true },
    orderBy: { name: 'asc' },
  });

  const allSettings = await prisma.settings.findMany({
    where: { OR: [{ outletId: { in: outlets.map(o => o.id) } }, { outletId: null }] },
  });

  const fallback = allSettings.find(s => s.outletId === null);
  const settingsByOutlet = new Map(allSettings.filter(s => s.outletId).map(s => [s.outletId, s]));

  const result = outlets.map(o => {
    const s = settingsByOutlet.get(o.id) ?? fallback;
    const config = readWebsiteConfig(s?.websiteConfig);
    const acceptingOrders = isAcceptingOrders({
      outletActive: o.isActive,
      onlineOrders: s?.onlineOrders ?? true,
      config,
    });
    return {
      id: o.id,
      name: o.name,
      address: o.address ?? null,
      city: o.city ?? null,
      phone: o.phone ?? null,
      acceptingOrders,
    };
  });

  res.setHeader('Cache-Control', 'public, max-age=300');
  res.json(ApiResponse.success(result));
});

export const getConfig = asyncHandler(async (req: Request, res: Response) => {
  const outlet = await getActiveOutlet(req.query.outletId);
  const settings = await getOutletSettings(outlet.id);
  
  const config = readWebsiteConfig(settings?.websiteConfig);
  const acceptingOrders = isAcceptingOrders({
    outletActive: outlet.isActive,
    onlineOrders: settings?.onlineOrders ?? true,
    config,
  });

  res.setHeader('Cache-Control', 'public, max-age=60');
  res.json(ApiResponse.success({
    outletId: outlet.id,
    outletName: outlet.name,
    acceptingOrders,
    orderTypes: WEBSITE_ORDER_TYPES,
    deliveryFee: config.deliveryFee,
    freeDeliveryAbove: config.freeDeliveryAbove,
    minOrder: config.minOrder,
    prepTimeMinutes: config.prepTimeMinutes,
    taxRate: settings?.taxRate ? Number(settings.taxRate) : 0,
    taxName: settings?.taxName ?? 'GST',
    currency: settings?.currency ?? 'PKR',
  }));
});

export const getMenu = asyncHandler(async (req: Request, res: Response) => {
  const outlet = await getActiveOutlet(req.query.outletId);
  const orderType = parseWebsiteOrderType(req.query.orderType);
  if (!orderType) throw ApiError.badRequest('Invalid orderType');

  const menu = await buildPublicMenu(prisma, { outletId: outlet.id, orderType });

  res.setHeader('Cache-Control', 'public, max-age=60');
  res.json(ApiResponse.success(menu));
});

export const getDeals = asyncHandler(async (req: Request, res: Response) => {
  const outlet = await getActiveOutlet(req.query.outletId);
  const orderType = parseWebsiteOrderType(req.query.orderType);
  if (!orderType) throw ApiError.badRequest('Invalid orderType');

  const deals = await prisma.deal.findMany({
    where: {
      status: { not: 'archived' },
      isActive: true,
      type: { notIn: ['PROMO_CODE', 'MIN_SPEND'] },
      ...(orderType === 'Delivery' ? { availableDelivery: true } : {}),
      ...(orderType === 'Take Away' ? { availableTakeaway: true } : {}),
      OR: [{ outletIds: { isEmpty: true } }, { outletIds: { has: outlet.id } }],
    },
    include: {
      components: { orderBy: { displayOrder: 'asc' as const } },
      bogoItems: { orderBy: { displayOrder: 'asc' as const } },
      optionGroups: {
        orderBy: { displayOrder: 'asc' as const },
        include: { options: { orderBy: { displayOrder: 'asc' as const } } },
      },
    },
    orderBy: { createdAt: 'desc' },
  });

  const liveDeals = deals.filter(
    (d: any) => isDealCurrentlyValid(d).valid && isDealAvailableForChannel(d, orderType),
  );

  res.setHeader('Cache-Control', 'public, max-age=60');
  res.json(ApiResponse.success(liveDeals.map((d: any) => mapDealOutPublic(d, orderType))));
});
