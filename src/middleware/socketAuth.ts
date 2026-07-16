/**
 * Socket.IO handshake authentication + outlet room assignment.
 *
 * Mirrors the HTTP `authenticate` middleware: same JWT verification, same
 * user/status checks, same Prisma-enum→string role mapping. Without this, any
 * client could open a socket and claim any outlet, which would make the
 * outlet-scoped event rooms meaningless as a boundary.
 *
 * On success the socket joins exactly one room:
 *   - Super Admin        → 'super-admin' (chain-wide, sees every outlet's events)
 *   - any other role     → 'outlet:<outletId>'
 *   - no outletId        → no room (receives nothing; they have no branch data)
 */

import type { Socket } from 'socket.io';
import jwt from 'jsonwebtoken';
import { prisma } from '../config/database.js';
import { env } from '../config/env.js';
import type { JwtPayload } from '../types/index.js';

// Same mapping as authenticate.ts — room logic must compare against the same
// role strings the rest of the app uses ('Super Admin', not 'SUPER_ADMIN').
const ROLE_MAP: Record<string, string> = {
  SUPER_ADMIN: 'Super Admin',
  ADMIN: 'Admin',
  MANAGER: 'Manager',
  CASHIER: 'Cashier',
  WAITER: 'Waiter',
  KITCHEN: 'Kitchen Staff',
  KITCHEN_MANAGER: 'Kitchen Manager',
  FLOOR_MANAGER: 'Floor Manager',
  DELIVERY_MANAGER: 'Delivery Manager',
  STORE_MANAGER: 'Store Manager',
  ACCOUNTANT: 'Accountant',
  RIDER: 'Rider',
  CUSTOMER_SCREEN: 'Customer Screen',
};

export async function socketAuth(
  socket: Socket,
  next: (err?: Error) => void
): Promise<void> {
  try {
    const token = socket.handshake.auth?.token as string | undefined;
    if (!token) return next(new Error('No token provided'));

    let decoded: JwtPayload;
    try {
      decoded = jwt.verify(token, env.JWT_SECRET) as JwtPayload;
    } catch {
      return next(new Error('Invalid or expired token'));
    }

    const user = await prisma.user.findUnique({
      where: { id: decoded.userId },
      select: { id: true, role: true, outletId: true, status: true },
    });

    if (!user) return next(new Error('User not found'));
    if (user.status !== 'active') return next(new Error('Account is deactivated'));

    const role = ROLE_MAP[user.role] || user.role;
    socket.data = { userId: user.id, role, outletId: user.outletId };

    if (role === 'Super Admin') {
      socket.join('super-admin');
    } else if (user.outletId) {
      socket.join(`outlet:${user.outletId}`);
    }
    // else: no outlet, no room — receives nothing, which is correct.

    next();
  } catch {
    next(new Error('Socket authentication failed'));
  }
}
