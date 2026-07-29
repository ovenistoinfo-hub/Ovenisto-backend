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
import { getIO } from '../../socket.js';

interface TableSocketState {
  hostSocketId: string;
  hostSessionToken: string;
  pendingRequest: { requesterSocketId: string } | null;
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
        ack?: (res: { role: 'host'; sessionToken: string } | { role: 'viewer' } | { error: string }) => void
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

        socket.join(roomName(tableId));
        socket.data.tableId = tableId;

        const state = tableStates.get(tableId);

        if (!state) {
          const sessionToken = randomUUID();
          tableStates.set(tableId, { hostSocketId: socket.id, hostSessionToken: sessionToken, pendingRequest: null });
          socket.data.role = 'host';
          ack?.({ role: 'host', sessionToken });
          return;
        }

        if (payload.sessionToken && payload.sessionToken === state.hostSessionToken) {
          // Reconnecting host (e.g. after a page refresh, which tears down and
          // re-creates the socket) — re-recognize as host, don't demote.
          state.hostSocketId = socket.id;
          socket.data.role = 'host';
          ack?.({ role: 'host', sessionToken: state.hostSessionToken });
          return;
        }

        socket.data.role = 'viewer';
        ack?.({ role: 'viewer' });
      }
    );

    socket.on('request-host', (_payload: unknown, ack?: (res: { sent: true } | { error: string }) => void) => {
      const tableId = socket.data.tableId as string | undefined;
      if (!tableId) { ack?.({ error: 'Not joined to a table' }); return; }
      const state = tableStates.get(tableId);
      if (!state) { ack?.({ error: 'No active session for this table' }); return; }
      if (state.hostSocketId === socket.id) { ack?.({ error: 'Already host' }); return; }
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
      nsp.to(requesterSocketId).emit('role:changed', { role: 'host', sessionToken: newToken });
      nsp.to(socket.id).emit('role:changed', { role: 'viewer' });
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
