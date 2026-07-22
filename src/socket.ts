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

export type ChallanEventType = 'challan:created' | 'challan:updated';
export type DemandEventType  = 'demand:created'  | 'demand:updated';

/** The room every Super Admin socket joins — they see chain-wide activity. */
const SUPER_ADMIN_ROOM = 'super-admin';

/**
 * Compute the Socket.IO rooms an outlet-scoped event should go to.
 *
 * Pure and io-free so it stays unit-testable (see __tests__/socket.test.ts).
 *
 * - null/undefined ids are dropped: the central MAIN warehouse has outletId null
 *   and has no outlet-scoped users, so there is no room to target for that side.
 * - Ids are deduped: a same-outlet Branch→Kitchen transfer names one outlet twice
 *   and must not emit twice.
 * - Super Admin always receives the event, regardless of outlet.
 */
export function resolveEventRooms(outletIds: (string | null | undefined)[]): string[] {
  const rooms = new Set<string>();
  for (const id of outletIds) {
    if (id) rooms.add(`outlet:${id}`);
  }
  rooms.add(SUPER_ADMIN_ROOM);
  return [...rooms];
}

/**
 * Emit an event to only the outlets it concerns (plus Super Admins).
 * Best-effort and non-throwing — a socket failure must never break the HTTP request.
 */
function emitToOutlets(
  event: string,
  payload: unknown,
  outletIds: (string | null | undefined)[]
): void {
  try {
    const io = getIO();
    if (!io) return;
    for (const room of resolveEventRooms(outletIds)) {
      io.to(room).emit(event, payload);
    }
  } catch {
    // Real-time delivery is non-critical; swallow so the API response is unaffected.
  }
}

/** Push a challan change to the source/destination outlets so Transfers pages update live. */
export function emitChallanEvent(
  event: ChallanEventType,
  payload: unknown,
  outletIds: (string | null | undefined)[]
): void {
  emitToOutlets(event, payload, outletIds);
}

/** Push a demand change to the requesting/supplying outlets so Demands pages update live. */
export function emitDemandEvent(
  event: DemandEventType,
  payload: unknown,
  outletIds: (string | null | undefined)[]
): void {
  emitToOutlets(event, payload, outletIds);
}

export type CancellationRequestEventType = 'cancellationRequest:created' | 'cancellationRequest:updated';

/**
 * Push a cancellation-request change (created/reviewed) so the approver inbox and
 * the requesting cashier's POS update live.
 *
 * Outlet-scoped: an OrderCancellationRequest carries its own `outletId` (copied from
 * the order at creation), so it targets exactly one room. Previously this broadcast
 * to every connected client, which made managers in unrelated branches refetch and
 * toast for a request they can't even see — the list endpoint is outlet-filtered.
 */
export function emitCancellationRequestEvent(
  event: CancellationRequestEventType,
  payload: unknown,
  outletIds: (string | null | undefined)[]
): void {
  emitToOutlets(event, payload, outletIds);
}

export type TableEventType = 'table:created' | 'table:updated' | 'table:deleted';

/** Push a table change to the outlet room so waiter panel and POS update live. */
export function emitTableEvent(
  event: TableEventType,
  payload: unknown,
  outletIds: (string | null | undefined)[]
): void {
  emitToOutlets(event, payload, outletIds);
}

export type ReservationEventType = 'reservation:created' | 'reservation:updated' | 'reservation:deleted';

/** Push a reservation change to the outlet room so Reservations page, POS, and Waiter Panel update live. */
export function emitReservationEvent(
  event: ReservationEventType,
  payload: unknown,
  outletIds: (string | null | undefined)[]
): void {
  emitToOutlets(event, payload, outletIds);
}

export type PurchaseEventType = 'purchase:created' | 'purchase:updated' | 'purchase:deleted';
export type PurchaseRequestEventType = 'purchaseRequest:created' | 'purchaseRequest:updated';

/** Push a purchase change to the owning outlet so Purchases pages update live. */
export function emitPurchaseEvent(
  event: PurchaseEventType,
  payload: unknown,
  outletIds: (string | null | undefined)[]
): void {
  emitToOutlets(event, payload, outletIds);
}

/** Push a requisition change to the target warehouse's outlet. */
export function emitPurchaseRequestEvent(
  event: PurchaseRequestEventType,
  payload: unknown,
  outletIds: (string | null | undefined)[]
): void {
  emitToOutlets(event, payload, outletIds);
}
