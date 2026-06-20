/** Expiry = made-at + shelf life (hours). */
export function computeExpiry(createdAt: Date, shelfLifeHours: number): Date {
  return new Date(createdAt.getTime() + shelfLifeHours * 60 * 60 * 1000);
}

/** Whole minutes from now until expiry; floored at 0. */
export function minutesRemaining(expiresAt: Date, now: Date): number {
  const ms = expiresAt.getTime() - now.getTime();
  return ms <= 0 ? 0 : Math.floor(ms / 60000);
}

/** active (>60 min) | near-expiry (<=60 min, >0) | expired (<=0). */
export function batchStatus(expiresAt: Date, now: Date): 'active' | 'near-expiry' | 'expired' {
  const mins = (expiresAt.getTime() - now.getTime()) / 60000;
  if (mins <= 0) return 'expired';
  if (mins <= 60) return 'near-expiry';
  return 'active';
}

/**
 * Draw `qty` down across batches in the given order (caller passes oldest-first).
 * Returns only the batches actually touched, with their new remaining (floored at 0).
 */
export function fifoDrawdown(
  batches: { id: string; remainingQty: number }[],
  qty: number
): { id: string; newRemaining: number }[] {
  const out: { id: string; newRemaining: number }[] = [];
  let need = qty;
  for (const b of batches) {
    if (need <= 0) break;
    const take = Math.min(b.remainingQty, need);
    out.push({ id: b.id, newRemaining: b.remainingQty - take });
    need -= take;
  }
  return out;
}
