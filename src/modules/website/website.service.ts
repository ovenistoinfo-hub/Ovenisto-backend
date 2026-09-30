import { prisma } from '../../config/database.js';
import { ApiError } from '../../utils/ApiError.js';

export async function getActiveOutlet(outletId: unknown) {
  if (typeof outletId !== 'string') throw ApiError.badRequest('outletId is required');
  const outlet = await prisma.outlet.findUnique({ where: { id: outletId } });
  if (!outlet || !outlet.isActive) throw ApiError.notFound('Outlet not found');
  return outlet;
}

export async function getOutletSettings(outletId: string) {
  const specific = await prisma.settings.findFirst({ where: { outletId } });
  if (specific) return specific;
  const fallback = await prisma.settings.findFirst();
  return fallback;
}

import { PrismaClient } from '@prisma/client';

export async function findOrCreateWebsiteCustomer(prisma: PrismaClient, params: { name: string, phone: string, address?: string | null }) {
  const digits11 = params.phone.replace('-', '');
  let customer = await prisma.customer.findFirst({
    where: { OR: [{ phone: params.phone }, { phone: digits11 }] }
  });

  if (!customer) {
    customer = await prisma.customer.create({
      data: {
        name: params.name,
        phone: params.phone,
        address: params.address || null,
        customerType: 'walk-in'
      }
    });
  }
  return customer;
}

