// Who took a booking's advance, and what may still change about it. A tracked advance (amount > 0 and a
// collector) sits on the collector's Cash Hub balance until it is settled or refunded, so its amount
// must not move under a settlement or an order that already uses it. Pure — the controller does the DB.

export interface AdvanceRecord {
  advancePaid: unknown;
  advanceCollectedById: string | null;
  advanceSettlementId: string | null;
  advanceRefunded: boolean;
  status: string;
}

type Staff = { id: string; name?: string | null } | undefined;

export type AdvanceUpdateResult =
  | { ok: true; data: Record<string, unknown> }
  | { ok: false; message: string };

const amountOf = (v: unknown) => {
  const n = Number(v ?? 0);
  return Number.isFinite(n) && n > 0 ? n : 0;
};

export function isTrackedAdvance(r: { advancePaid: unknown; advanceCollectedById: string | null }): boolean {
  return amountOf(r.advancePaid) > 0 && !!r.advanceCollectedById;
}

/** The collector stamp for a booking created with an advance. */
export function advanceStampOnCreate(advancePaid: unknown, user: Staff, now: Date): Record<string, unknown> {
  if (amountOf(advancePaid) === 0 || !user) return {};
  return { advanceCollectedById: user.id, advanceCollectedByName: user.name ?? null, advanceCollectedAt: now };
}

/**
 * The advance fields an update should write, or why it must be refused. `linkedOrderNumber` is the
 * order already carrying this booking's advance (Order.reservationId), if any.
 */
export function advanceChangesOnUpdate(
  existing: AdvanceRecord,
  body: { advancePaid?: unknown; status?: unknown; advanceRefunded?: unknown },
  ctx: { user: Staff; now: Date; linkedOrderNumber: string | null }
): AdvanceUpdateResult {
  const prev = amountOf(existing.advancePaid);
  const next = body.advancePaid !== undefined ? amountOf(body.advancePaid) : prev;
  const changed = Math.abs(next - prev) > 0.001;

  if (changed && existing.advanceSettlementId) {
    return { ok: false, message: 'This advance was already handed over in Cash Hub, so it can\'t be changed.' };
  }
  if (changed && ctx.linkedOrderNumber) {
    return { ok: false, message: `This advance is already on order ${ctx.linkedOrderNumber}, so it can't be changed.` };
  }

  const data: Record<string, unknown> = {};
  if (next > 0 && !existing.advanceCollectedById && ctx.user) {
    Object.assign(data, advanceStampOnCreate(next, ctx.user, ctx.now));
  } else if (next === 0 && existing.advanceCollectedById && !existing.advanceSettlementId) {
    Object.assign(data, { advanceCollectedById: null, advanceCollectedByName: null, advanceCollectedAt: null, advanceRefunded: false });
  }

  const nextStatus = body.status !== undefined ? String(body.status) : existing.status;
  if (body.advanceRefunded !== undefined) {
    const refunded = body.advanceRefunded === true;
    if (refunded) {
      if (nextStatus !== 'cancelled') return { ok: false, message: 'Only a cancelled booking\'s advance can be marked refunded.' };
      if (existing.advanceSettlementId) {
        return { ok: false, message: 'This advance was already handed over in Cash Hub. Record the refund as an expense instead.' };
      }
      if (ctx.linkedOrderNumber) return { ok: false, message: `This advance is already on order ${ctx.linkedOrderNumber}.` };
    }
    data.advanceRefunded = refunded;
  } else if (nextStatus !== 'cancelled' && existing.advanceRefunded) {
    data.advanceRefunded = false;
  }

  return { ok: true, data };
}

/** Why a booking can't be deleted (its advance is still open in Cash Hub), or null. */
export function advanceDeleteBlock(existing: AdvanceRecord): string | null {
  if (isTrackedAdvance(existing) && !existing.advanceSettlementId && !existing.advanceRefunded) {
    return 'Cancel this booking instead and say whether the advance was refunded. Deleting it would drop the advance from Cash Hub.';
  }
  return null;
}
