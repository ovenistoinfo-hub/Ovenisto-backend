/**
 * Self-Order Socket.IO namespace.
 *
 * A separate `/self-order` namespace, deliberately NOT gated by socketAuth's
 * JWT requirement (a customer scanning a QR code has no login). Each socket
 * joins a room keyed by the real table id (validated server-side, never
 * trusted from the client) and the first joiner becomes that table's "host" —
 * the only session allowed to place an order — tracked in-memory here, not in
 * the database. See docs/superpowers/specs/2026-07-29-self-order-session-and-customer-linking-design.md
 * for the full design rationale, including the accepted in-memory-only
 * limitation (host state resets on a server restart).
 */

import type { Server as SocketServer, Namespace } from 'socket.io';
import { randomUUID } from 'crypto';
import { prisma } from '../../config/database.js';
import { getIO, emitCallWaiterEvent } from '../../socket.js';

interface TableSocketState {
  hostSocketId: string;
  hostSessionToken: string;
  pendingRequest: { requesterSocketId: string } | null;
  guestCount: number | null;
  /** Opaque id minted fresh whenever a table's self-order state is (re)created
   *  from scratch — i.e. a genuinely new sitting. Safe to hand to viewers too
   *  (unlike hostSessionToken, it can't be replayed to claim host) so every
   *  device, host or viewer, can tell "is this still the sitting I last saw"
   *  and reset its own stale local data (old orders, old entry-gate answers)
   *  when it isn't. Untouched across a same-sitting host handoff (takeover
   *  approval), since that's still the same sitting continuing. */
  sittingGeneration: string;
}

const tableStates = new Map<string, TableSocketState>();

function roomName(tableId: string): string {
  return `self-order-table:${tableId}`;
}

/** Called once at boot from index.ts, after the Socket.IO server is created. */
export function setupSelfOrderNamespace(io: SocketServer): void {
  const nsp: Namespace = io.of('/self-order');

  nsp.on('connection', (socket) => {
    socket.on(
      'join-table',
      async (
        payload: { tableId?: string; sessionToken?: string },
        ack?: (
          res:
            | { role: 'host'; sessionToken: string; sittingGeneration: string }
            | { role: 'viewer'; sittingGeneration: string }
            | { role: 'blocked'; reason: 'table-occupied' }
            | { error: string }
        ) => void
      ) => {
        const tableId = payload?.tableId;
        if (!tableId) {
          ack?.({ error: 'tableId is required' });
          return;
        }
        const table = await prisma.restaurantTable.findUnique({ where: { id: tableId } });
        if (!table) {
          ack?.({ error: 'Table not found' });
          return;
        }

        const state = tableStates.get(tableId);

        // No self-order session exists yet for this table. If it's already
        // occupied, that occupancy came from a staff-direct sitting (POS/Waiter
        // Panel) — self-order's own acceptance flow only occupies a table AFTER
        // a session already exists (see createSelfOrder's comment), so reaching
        // "occupied" with no session here can only mean staff is already
        // handling this table directly. Block instead of silently becoming host
        // and colliding with an order channel the customer doesn't know about.
        if (!state && table.status === 'occupied') {
          ack?.({ role: 'blocked', reason: 'table-occupied' });
          return;
        }

        socket.join(roomName(tableId));
        socket.data.tableId = tableId;

        if (!state) {
          const sessionToken = randomUUID();
          const sittingGeneration = randomUUID();
          tableStates.set(tableId, { hostSocketId: socket.id, hostSessionToken: sessionToken, pendingRequest: null, guestCount: null, sittingGeneration });
          socket.data.role = 'host';
          ack?.({ role: 'host', sessionToken, sittingGeneration });
          return;
        }

        if (payload.sessionToken && payload.sessionToken === state.hostSessionToken) {
          // Reconnecting host (e.g. after a page refresh, which tears down and
          // re-creates the socket) — re-recognize as host, don't demote.
          state.hostSocketId = socket.id;
          socket.data.role = 'host';
          ack?.({ role: 'host', sessionToken: state.hostSessionToken, sittingGeneration: state.sittingGeneration });
          // A takeover request may have arrived while this host was
          // transiently disconnected (e.g. a backgrounded mobile tab) — a
          // fire-and-forget emit made at that moment would otherwise be lost
          // forever. Replay it now that the host is back.
          if (state.pendingRequest) {
            nsp.to(socket.id).emit('host-request');
          }
          return;
        }

        socket.data.role = 'viewer';
        ack?.({ role: 'viewer', sittingGeneration: state.sittingGeneration });
      }
    );

    socket.on('update-guest-count', (payload: { guestCount?: number }) => {
      const tableId = socket.data.tableId as string | undefined;
      if (!tableId) return;
      const state = tableStates.get(tableId);
      if (!state || state.hostSocketId !== socket.id) return;
      if (typeof payload?.guestCount === 'number' && payload.guestCount >= 1) {
        state.guestCount = payload.guestCount;
      }
    });

    socket.on('request-host', (_payload: unknown, ack?: (res: { sent: true } | { error: string }) => void) => {
      const tableId = socket.data.tableId as string | undefined;
      if (!tableId) { ack?.({ error: 'Not joined to a table' }); return; }
      const state = tableStates.get(tableId);
      if (!state) { ack?.({ error: 'No active session for this table' }); return; }
      if (state.hostSocketId === socket.id) { ack?.({ error: 'Already host' }); return; }

      // The recorded host's socket may no longer be connected — e.g. a stale
      // slot left behind by a table-free path that doesn't call
      // clearSelfOrderTableState (WaiterPanel's moveTableSession, or the admin
      // TableLayout table editor), or simply a dropped connection. If so, there
      // is no one left who could ever approve a pending request, so promote
      // the requester immediately instead of leaving them stuck forever.
      // `nsp.sockets` is Socket.IO's own live registry of connected sockets in
      // this namespace — a reliable, no-extra-state way to prove liveness.
      if (!nsp.sockets.has(state.hostSocketId)) {
        const newToken = randomUUID();
        state.hostSocketId = socket.id;
        state.hostSessionToken = newToken;
        state.pendingRequest = null;
        socket.data.role = 'host';
        nsp.to(socket.id).emit('role:changed', { role: 'host', sessionToken: newToken, guestCount: state.guestCount, sittingGeneration: state.sittingGeneration });
        ack?.({ sent: true });
        return;
      }

      state.pendingRequest = { requesterSocketId: socket.id };
      nsp.to(state.hostSocketId).emit('host-request');
      ack?.({ sent: true });
    });

    socket.on('respond-host-request', (payload: { approve?: boolean }) => {
      const tableId = socket.data.tableId as string | undefined;
      if (!tableId) return;
      const state = tableStates.get(tableId);
      if (!state || state.hostSocketId !== socket.id || !state.pendingRequest) return;

      const requesterSocketId = state.pendingRequest.requesterSocketId;
      state.pendingRequest = null;

      if (!payload?.approve) {
        nsp.to(requesterSocketId).emit('host-request:declined');
        return;
      }

      const newToken = randomUUID();
      state.hostSocketId = requesterSocketId;
      state.hostSessionToken = newToken;
      nsp.to(requesterSocketId).emit('role:changed', { role: 'host', sessionToken: newToken, guestCount: state.guestCount, sittingGeneration: state.sittingGeneration });
      nsp.to(socket.id).emit('role:changed', { role: 'viewer', sittingGeneration: state.sittingGeneration });
    });

    socket.on('call-waiter', async () => {
      const tableId = socket.data.tableId as string | undefined;
      if (!tableId) return;
      try {
        const table = await prisma.restaurantTable.findUnique({ where: { id: tableId } });
        if (!table?.outletId) return;
        emitCallWaiterEvent({ tableId: table.id, tableNumber: table.number }, table.outletId);
      } catch {
        // Real-time delivery is non-critical; swallow so the socket connection is unaffected.
      }
    });

    socket.on('disconnect', () => {
      const tableId = socket.data.tableId as string | undefined;
      if (!tableId) return;
      const state = tableStates.get(tableId);
      if (!state) return;
      // Do NOT clear a disconnected host's slot — they may reconnect with the
      // same sessionToken (a refresh does exactly this). Only clean up a
      // pending request if the requester who disconnected was the one waiting.
      if (state.pendingRequest?.requesterSocketId === socket.id) {
        state.pendingRequest = null;
      }
    });
  });
}

/** Push an event to everyone in a table's room. Best-effort, non-throwing. */
export function emitSelfOrderTableEvent(tableId: string, event: string, payload: unknown): void {
  try {
    getIO()?.of('/self-order').to(roomName(tableId)).emit(event, payload);
  } catch {
    // Real-time delivery is non-critical; swallow so the API response is unaffected.
  }
}

/**
 * Resolve an order's table (by outletId + tableNumber, since Order has no
 * direct table-id FK) and push an event into that table's room. Used by
 * order.controller.ts's self-order-related status transitions.
 */
export async function emitSelfOrderEventForOrder(
  order: { outletId: string | null; tableNumber: number | null },
  event: string,
  payload: unknown
): Promise<void> {
  try {
    if (!order.outletId || !order.tableNumber) return;
    const table = await prisma.restaurantTable.findFirst({
      where: { outletId: order.outletId, number: String(order.tableNumber) },
    });
    if (!table) return;
    emitSelfOrderTableEvent(table.id, event, payload);
  } catch {
    // Real-time delivery is non-critical; swallow so the API response is unaffected.
  }
}

/** Clears a table's in-memory session state entirely (called on End Sitting),
 *  so the next customer to scan that table's QR gets a genuinely fresh host
 *  assignment rather than being blocked by a stale entry. */
export function clearSelfOrderTableState(tableId: string): void {
  tableStates.delete(tableId);
}
