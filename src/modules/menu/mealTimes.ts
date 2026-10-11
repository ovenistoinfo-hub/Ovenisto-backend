/** Meal serving times (Breakfast 8–11…) per branch, shared by the website and self-order. */
import type { PrismaClient } from '@prisma/client';
import { ApiError } from '../../utils/ApiError.js';
import { readWebsiteConfig, isServedAt, format12h } from '../website/website.helpers.js';

export type BranchMealType = { id: string; name: string; hours: { open: string; close: string } | null };

/** Active meal types with this branch's serving time (staff Settings → Website → Meal times; null = all day). */
export async function loadBranchMealTypes(prisma: PrismaClient, outletId: string | null): Promise<BranchMealType[]> {
  const [settings, mealTypes] = await Promise.all([
    outletId
      ? prisma.settings.findFirst({ where: { outletId } }).then((s) => s ?? prisma.settings.findFirst())
      : Promise.resolve(null),
    prisma.mealType.findMany({ where: { status: 'active' }, orderBy: { name: 'asc' }, select: { id: true, name: true } }),
  ]);
  const { mealHours } = readWebsiteConfig(settings?.websiteConfig);
  return mealTypes.map((m) => ({ ...m, hours: mealHours[m.id] ?? null }));
}

/** 400 when the dish isn't served at `minute` (PKT), naming its meal windows and ending with `hint`. */
export function assertServedAt(dish: { name: string; mealTypeIds: string[] }, mealTypes: BranchMealType[], minute: number, hint: string): void {
  const timed = mealTypes.filter((m) => m.hours);
  if (isServedAt(dish.mealTypeIds, Object.fromEntries(timed.map((m) => [m.id, m.hours!])), minute)) return;
  const windows = timed
    .filter((m) => dish.mealTypeIds.includes(m.id))
    .map((m) => `${m.name} (${format12h(m.hours!.open)} – ${format12h(m.hours!.close)})`)
    .join(' or ');
  throw ApiError.badRequest(`"${dish.name}" is only served during ${windows}. ${hint}`);
}
