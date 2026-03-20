/**
 * Shared TypeScript Types
 * Common types used across the backend
 */

// ============================================
// Pagination
// ============================================

export interface PaginationParams {
  page: number;
  limit: number;
}

export interface PaginatedResult<T> {
  data: T[];
  meta: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
}

// ============================================
// User & Auth Types
// ============================================

export type UserRole =
  | 'Super Admin'
  | 'Admin'
  | 'Manager'
  | 'Cashier'
  | 'Waiter'
  | 'Kitchen Staff'
  | 'Kitchen Manager'
  | 'Floor Manager'
  | 'Delivery Manager'
  | 'Store Manager'
  | 'Accountant'
  | 'Rider'
  | 'Customer Screen';

export interface JwtPayload {
  userId: string;
  email: string;
  role: string; // mapped human-readable role string (e.g. 'Super Admin')
  outletId?: string;
  iat?: number;
  exp?: number;
}

export interface AuthUser {
  id: string;
  name: string;
  email: string;
  role: string;
  outletId?: string;
  avatar?: string;
}

// ============================================
// Order Types
// ============================================

export type OrderType =
  | 'Dine In'
  | 'Take Away'
  | 'Delivery'
  | 'Online'
  | 'Self Order'
  | 'Foodpanda'
  | 'Walk-in';

export type OrderStatus =
  | 'pending'
  | 'preparing'
  | 'ready'
  | 'completed'
  | 'cancelled'
  | 'scheduled';

export type CustomerType = 'walk-in' | 'regular' | 'corporate' | 'vip';

export type OrderSource = 'pos' | 'self-order' | 'website' | 'foodpanda' | 'phone';

// ============================================
// Stock Types
// ============================================

export type StockAdjustmentType = 'add' | 'deduct' | 'damage' | 'correction';

// ============================================
// Delivery Types
// ============================================

export type DeliveryStatus = 'pending' | 'dispatched' | 'delivered' | 'returned';

// ============================================
// Reservation Types
// ============================================

export type ReservationStatus =
  | 'pending'
  | 'confirmed'
  | 'seated'
  | 'completed'
  | 'cancelled'
  | 'noShow';

export type ReservationSource = 'phone' | 'walkin' | 'online';

// ============================================
// Financial Types
// ============================================

export type PaymentMethod = 'cash' | 'card' | 'online' | 'credit';

export type ExpenseCategory =
  | 'Rent'
  | 'Utilities'
  | 'Salaries'
  | 'Maintenance'
  | 'Marketing'
  | 'Supplies'
  | 'Other';

// ============================================
// HR Types
// ============================================

export type LeaveType = 'sick' | 'casual' | 'annual' | 'emergency';

export type ShiftStatus = 'open' | 'closed';

// ============================================
// Deal & Coupon Types
// ============================================

export type DealType =
  | 'percentage'
  | 'combo'
  | 'buyXgetY'
  | 'timeBased'
  | 'optionCombo';

export type CouponType = 'percentage' | 'fixed';

// ============================================
// Socket Events
// ============================================

export interface SocketEvents {
  // Kitchen events
  'kitchen:new_order': { orderId: string; orderNumber: string };
  'kitchen:order_cancelled': { orderId: string; reason: string };

  // POS events
  'pos:order_status_changed': {
    orderId: string;
    status: OrderStatus;
    updatedBy: string;
  };

  // Waiter events
  'waiter:order_ready': {
    orderId: string;
    orderNumber: string;
    tableNumber?: number;
  };

  // Display events
  'display:order_update': {
    orderId: string;
    orderNumber: string;
    status: OrderStatus;
  };
}
