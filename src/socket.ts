/**
 * Socket.IO server registry + emit helpers.
 *
 * Centralizes the io instance so any module can emit real-time events without
 * importing from index.ts (which would create a circular dependency). Controllers
 * call emitOrderEvent(...) to push order changes to connected KDS / POS / status
 * boards instead of those screens polling the DB on a timer.
 */

import type { Server as SocketServer } from 'socket.io';

let ioRef: SocketServer | null = null;

/** Called once at boot from index.ts after the Socket.IO server is created. */
export function registerIO(io: SocketServer): void {
  ioRef = io;
}

/** Returns the io instance, or null if sockets aren't initialized (e.g. in tests). */
export function getIO(): SocketServer | null {
  return ioRef;
}

export type OrderEventType = 'order:created' | 'order:updated' | 'order:deleted';

/**
 * Push an order change to all connected clients. Best-effort and non-throwing —
 * a socket failure must never break the HTTP request that triggered it.
 * Clients listen for these events and refetch/update instead of polling on a clock.
 */
export function emitOrderEvent(event: OrderEventType, payload: unknown): void {
  try {
    ioRef?.emit(event, payload);
  } catch {
    // Real-time delivery is non-critical; swallow so the API response is unaffected.
  }
}
