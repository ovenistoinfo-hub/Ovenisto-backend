/**
 * Shared Prisma select and mapper for user fields with outlet.
 */

export const USER_SELECT = {
  id: true, name: true, phone: true, role: true,
  outlet: { select: { name: true } },
} as const;

export function mapUser(u: any) {
  if (!u) return null;
  return {
    id: u.id,
    name: u.name,
    phone: u.phone ?? null,
    role: u.role ?? null,
    outlet: u.outlet?.name ?? null,
  };
}
