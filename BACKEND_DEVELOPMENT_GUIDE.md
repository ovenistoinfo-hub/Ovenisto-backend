# Ovenisto Backend Development Guide

> Complete backend roadmap generated from frontend codebase analysis.
> Frontend Stack: React 18 + TypeScript + Vite 5 + Tailwind CSS + shadcn/ui
> Current State: All data is stored in localStorage via DataContext (key: `ovenisto_data`)

---

## Table of Contents

1. [Architecture Overview](#1-architecture-overview)
2. [Recommended Tech Stack](#2-recommended-tech-stack)
3. [Database Schema](#3-database-schema)
4. [Implementation Phases (Priority Order)](#4-implementation-phases)
5. [Phase 1: Authentication & Users](#phase-1-authentication--users)
6. [Phase 2: Restaurant Settings & Outlets](#phase-2-restaurant-settings--outlets)
7. [Phase 3: Menu Management](#phase-3-menu-management)
8. [Phase 4: Inventory & Ingredients](#phase-4-inventory--ingredients)
9. [Phase 5: Orders & POS](#phase-5-orders--pos)
10. [Phase 6: Customers & Loyalty](#phase-6-customers--loyalty)
11. [Phase 7: Financial Module](#phase-7-financial-module)
12. [Phase 8: Delivery Management](#phase-8-delivery-management)
13. [Phase 9: HR & Staff Management](#phase-9-hr--staff-management)
14. [Phase 10: Advanced Features](#phase-10-advanced-features)
15. [Frontend Integration Guide](#frontend-integration-guide)

---

## 1. Architecture Overview

### Current Frontend Data Flow
```
React App → DataContext (useState) → localStorage ("ovenisto_data")
                ↓
        41 collections stored as one JSON blob
        Generic CRUD: addItem(), updateItem(), removeItem()
        Special: addOrder() (auto stock deduction), adjustStock(), updateSettings()
```

### Target Backend Architecture
```
React App → API Service Layer → REST/GraphQL API → Backend Server → Database
                                      ↓
                              Authentication Middleware (JWT)
                              Role-based Access Control
                              Real-time WebSocket (for KDS, POS sync)
```

### Frontend Roles & Permissions (to replicate in backend)
| Role          | Access                                                                |
|---------------|-----------------------------------------------------------------------|
| Super Admin   | Everything (`*`)                                                      |
| Admin         | Everything (`*`)                                                      |
| Manager       | dashboard, analytics, pos, kitchens, waiter, order-status, items, stock, sales, customers, purchases, suppliers, expenses, transfers, waste, attendance, reports, sms |
| Cashier       | dashboard, pos, sales, customers, customer-dues                       |
| Waiter        | waiter panel only                                                     |
| Kitchen Staff | kitchens panel only                                                   |

---

## 2. Recommended Tech Stack

### Option A: Node.js (Fastest to integrate with existing React frontend)
- **Runtime**: Node.js 20+
- **Framework**: Express.js or Fastify
- **ORM**: Prisma or Drizzle
- **Database**: PostgreSQL
- **Auth**: JWT + bcrypt
- **Validation**: Zod (already used in frontend patterns)
- **Real-time**: Socket.IO (for kitchen display, POS sync)

### Option B: Python (If team prefers Python)
- **Framework**: FastAPI
- **ORM**: SQLAlchemy / Tortoise ORM
- **Database**: PostgreSQL
- **Auth**: JWT + passlib

### Recommended: **Option A (Node.js + Express + Prisma + PostgreSQL)**

---

## 3. Database Schema

### Core Tables (41 collections → ~30 normalized tables)

```sql
-- =============================================
-- PHASE 1: Auth & Users
-- =============================================

CREATE TABLE outlets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(100) NOT NULL,
  code VARCHAR(20) UNIQUE NOT NULL,
  address TEXT,
  city VARCHAR(50),
  phone VARCHAR(20),
  email VARCHAR(100),
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(100) NOT NULL,
  email VARCHAR(100) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  phone VARCHAR(20),
  role VARCHAR(30) NOT NULL CHECK (role IN ('Super Admin','Admin','Manager','Cashier','Waiter','Kitchen Staff')),
  branch VARCHAR(100),
  outlet_id UUID REFERENCES outlets(id),
  avatar TEXT,
  status VARCHAR(20) DEFAULT 'active',
  last_login TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW()
);

-- =============================================
-- PHASE 2: Settings
-- =============================================

CREATE TABLE settings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  outlet_id UUID REFERENCES outlets(id),
  restaurant_name VARCHAR(100),
  currency VARCHAR(10) DEFAULT 'Rs.',
  tax_rate DECIMAL(5,2) DEFAULT 16,
  tax_name VARCHAR(20) DEFAULT 'GST',
  phone VARCHAR(20),
  email VARCHAR(100),
  address TEXT,
  receipt_header TEXT,
  table_management BOOLEAN DEFAULT true,
  online_orders BOOLEAN DEFAULT true,
  reservations BOOLEAN DEFAULT false,
  self_order_config JSONB DEFAULT '{}',
  website_config JSONB DEFAULT '{}',
  reservation_config JSONB DEFAULT '{}',
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- =============================================
-- PHASE 3: Menu Management
-- =============================================

CREATE TABLE food_categories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(100) NOT NULL,
  display_order INT DEFAULT 0,
  status VARCHAR(20) DEFAULT 'active'
);

CREATE TABLE food_menu_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(100) NOT NULL,
  code VARCHAR(20) UNIQUE,
  category_id UUID REFERENCES food_categories(id),
  price DECIMAL(10,2) NOT NULL,
  available BOOLEAN DEFAULT true,
  image TEXT,
  tags TEXT[], -- e.g. ['vegetarian', 'beverage']
  cooking_time INT DEFAULT 0, -- minutes
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE food_menu_variants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  menu_item_id UUID REFERENCES food_menu_items(id) ON DELETE CASCADE,
  name VARCHAR(100) NOT NULL, -- e.g. "Small 6\""
  price DECIMAL(10,2) NOT NULL,
  display_order INT DEFAULT 0
);

CREATE TABLE modifiers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(100) NOT NULL,
  price DECIMAL(10,2) DEFAULT 0,
  type VARCHAR(20) CHECK (type IN ('addon', 'removal')),
  status VARCHAR(20) DEFAULT 'active'
);

CREATE TABLE food_recipes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  menu_item_id UUID REFERENCES food_menu_items(id),
  ingredient_id UUID REFERENCES ingredients(id),
  qty_per_unit DECIMAL(10,4) NOT NULL
);

-- =============================================
-- PHASE 4: Inventory & Ingredients
-- =============================================

CREATE TABLE ingredient_categories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(100) NOT NULL,
  description TEXT,
  status VARCHAR(20) DEFAULT 'active'
);

CREATE TABLE ingredient_units (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(20) NOT NULL,
  status VARCHAR(20) DEFAULT 'active'
);

CREATE TABLE ingredients (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(100) NOT NULL,
  category_id UUID REFERENCES ingredient_categories(id),
  unit_id UUID REFERENCES ingredient_units(id),
  purchase_price DECIMAL(10,2),
  current_stock DECIMAL(10,3) DEFAULT 0,
  low_stock_level DECIMAL(10,3) DEFAULT 0,
  status VARCHAR(20) DEFAULT 'active'
);

CREATE TABLE pre_made_food (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(100) NOT NULL,
  unit VARCHAR(20),
  current_stock DECIMAL(10,3) DEFAULT 0,
  low_stock_level DECIMAL(10,3) DEFAULT 0,
  cost_per_unit DECIMAL(10,2),
  status VARCHAR(20) DEFAULT 'active'
);

CREATE TABLE stock_adjustments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ingredient_id UUID REFERENCES ingredients(id),
  type VARCHAR(20) CHECK (type IN ('add', 'deduct', 'damage', 'correction')),
  quantity DECIMAL(10,3) NOT NULL,
  reason TEXT,
  adjusted_by UUID REFERENCES users(id),
  date TIMESTAMP DEFAULT NOW()
);

CREATE TABLE stock_takes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  reference VARCHAR(20) UNIQUE,
  date DATE NOT NULL,
  status VARCHAR(20) DEFAULT 'active',
  counted_by VARCHAR(100),
  total_variance_value DECIMAL(10,2) DEFAULT 0,
  notes TEXT,
  completed_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE stock_take_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  stock_take_id UUID REFERENCES stock_takes(id) ON DELETE CASCADE,
  ingredient_id UUID REFERENCES ingredients(id),
  system_qty DECIMAL(10,3),
  counted_qty DECIMAL(10,3),
  variance DECIMAL(10,3),
  variance_value DECIMAL(10,2)
);

CREATE TABLE productions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  item_name VARCHAR(100),
  quantity DECIMAL(10,3),
  unit VARCHAR(20),
  produced_by VARCHAR(100),
  date TIMESTAMP DEFAULT NOW(),
  notes TEXT
);

CREATE TABLE transfers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  from_outlet_id UUID REFERENCES outlets(id),
  to_outlet_id UUID REFERENCES outlets(id),
  item_name VARCHAR(100),
  quantity DECIMAL(10,3),
  unit VARCHAR(20),
  status VARCHAR(20) DEFAULT 'pending',
  transferred_by VARCHAR(100),
  date TIMESTAMP DEFAULT NOW(),
  notes TEXT
);

CREATE TABLE waste_records (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  item_name VARCHAR(100),
  quantity DECIMAL(10,3),
  unit VARCHAR(20),
  reason TEXT,
  cost DECIMAL(10,2),
  recorded_by VARCHAR(100),
  date TIMESTAMP DEFAULT NOW()
);

-- =============================================
-- PHASE 5: Orders & POS
-- =============================================

CREATE TABLE orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_number VARCHAR(20) UNIQUE NOT NULL,
  customer_id UUID REFERENCES customers(id),
  customer_name VARCHAR(100),
  phone VARCHAR(20),
  type VARCHAR(30) CHECK (type IN ('Dine In','Take Away','Delivery','Online','Self Order','Foodpanda','Walk-in')),
  subtotal DECIMAL(10,2) NOT NULL,
  discount DECIMAL(10,2) DEFAULT 0,
  tax DECIMAL(10,2) DEFAULT 0,
  total DECIMAL(10,2) NOT NULL,
  status VARCHAR(20) DEFAULT 'pending' CHECK (status IN ('pending','preparing','ready','completed','cancelled','scheduled')),
  payment_method VARCHAR(30),
  date DATE NOT NULL,
  time VARCHAR(20),
  staff_id UUID REFERENCES users(id),
  staff_name VARCHAR(100),
  table_number INT,
  delivery_address TEXT,
  rider_id UUID REFERENCES delivery_riders(id),
  -- Future Sale fields
  is_future_sale BOOLEAN DEFAULT false,
  scheduled_date DATE,
  scheduled_time VARCHAR(20),
  future_notes TEXT,
  advance_payment DECIMAL(10,2) DEFAULT 0,
  -- Enhanced POS fields
  is_urgent BOOLEAN DEFAULT false,
  customer_type VARCHAR(20) CHECK (customer_type IN ('walk-in','regular','corporate','vip')),
  order_source VARCHAR(20) CHECK (order_source IN ('pos','self-order','website','foodpanda','phone')),
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE order_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id UUID REFERENCES orders(id) ON DELETE CASCADE,
  menu_item_id UUID REFERENCES food_menu_items(id),
  name VARCHAR(100) NOT NULL,
  price DECIMAL(10,2) NOT NULL,
  qty INT NOT NULL,
  discount DECIMAL(10,2) DEFAULT 0,
  modifiers TEXT[], -- modifier names
  cooking_time INT,
  notes TEXT
);

CREATE TABLE order_modification_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id UUID REFERENCES orders(id) ON DELETE CASCADE,
  action VARCHAR(30) CHECK (action IN ('item_added','item_removed','qty_changed','discount_changed','cancelled','type_changed','notes_changed')),
  detail TEXT,
  staff VARCHAR(100),
  timestamp TIMESTAMP DEFAULT NOW()
);

-- =============================================
-- PHASE 6: Customers & Loyalty
-- =============================================

CREATE TABLE customers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(100) NOT NULL,
  phone VARCHAR(20),
  email VARCHAR(100),
  address TEXT,
  customer_type VARCHAR(20) DEFAULT 'walk-in' CHECK (customer_type IN ('walk-in','regular','corporate','vip')),
  loyalty_points INT DEFAULT 0,
  custom_price_list VARCHAR(50),
  total_orders INT DEFAULT 0,
  total_spent DECIMAL(12,2) DEFAULT 0,
  outstanding_due DECIMAL(10,2) DEFAULT 0,
  last_order DATE,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE loyalty_settings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  outlet_id UUID REFERENCES outlets(id),
  points_per_amount INT DEFAULT 1,
  amount_per_point DECIMAL(10,2) DEFAULT 100,
  signup_bonus INT DEFAULT 100,
  birthday_bonus INT DEFAULT 50,
  tiers JSONB DEFAULT '[]'
);

CREATE TABLE loyalty_members (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id UUID REFERENCES customers(id),
  phone VARCHAR(20),
  total_points INT DEFAULT 0,
  available_points INT DEFAULT 0,
  tier VARCHAR(30) DEFAULT 'Bronze',
  joined_date DATE DEFAULT CURRENT_DATE
);

CREATE TABLE loyalty_rewards (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(100),
  points_required INT NOT NULL,
  type VARCHAR(30) CHECK (type IN ('freeItem','percentDiscount','fixedDiscount')),
  value VARCHAR(100),
  is_active BOOLEAN DEFAULT true
);

CREATE TABLE loyalty_transactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  member_id UUID REFERENCES loyalty_members(id),
  type VARCHAR(10) CHECK (type IN ('earn','redeem')),
  points INT NOT NULL,
  description TEXT,
  order_id UUID REFERENCES orders(id),
  date DATE DEFAULT CURRENT_DATE
);

-- =============================================
-- PHASE 7: Financial
-- =============================================

CREATE TABLE suppliers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(100) NOT NULL,
  company VARCHAR(100),
  phone VARCHAR(20),
  email VARCHAR(100),
  total_purchases DECIMAL(12,2) DEFAULT 0,
  total_due DECIMAL(10,2) DEFAULT 0,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE purchases (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  supplier_id UUID REFERENCES suppliers(id),
  invoice_number VARCHAR(30),
  items JSONB NOT NULL, -- [{name, qty, unit, price, total}]
  subtotal DECIMAL(10,2),
  tax DECIMAL(10,2),
  total DECIMAL(10,2),
  paid DECIMAL(10,2) DEFAULT 0,
  due DECIMAL(10,2) DEFAULT 0,
  status VARCHAR(20) DEFAULT 'pending',
  date DATE DEFAULT CURRENT_DATE,
  notes TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE expenses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  category VARCHAR(50),
  description TEXT,
  amount DECIMAL(10,2) NOT NULL,
  payment_method VARCHAR(30),
  reference VARCHAR(50),
  date DATE DEFAULT CURRENT_DATE,
  recorded_by VARCHAR(100),
  created_at TIMESTAMP DEFAULT NOW()
);

-- =============================================
-- PHASE 8: Delivery
-- =============================================

CREATE TABLE delivery_riders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(100) NOT NULL,
  phone VARCHAR(20),
  is_available BOOLEAN DEFAULT true,
  active_deliveries INT DEFAULT 0
);

CREATE TABLE delivery_assignments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id UUID REFERENCES orders(id),
  rider_id UUID REFERENCES delivery_riders(id),
  status VARCHAR(20) DEFAULT 'pending' CHECK (status IN ('pending','dispatched','delivered','returned')),
  assigned_at TIMESTAMP DEFAULT NOW(),
  delivered_at TIMESTAMP,
  estimated_time INT, -- minutes
  customer_address TEXT,
  customer_phone VARCHAR(20),
  notes TEXT
);

-- =============================================
-- PHASE 9: HR & Staff
-- =============================================

CREATE TABLE attendance (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id),
  date DATE NOT NULL,
  check_in TIMESTAMP,
  check_out TIMESTAMP,
  status VARCHAR(20) DEFAULT 'present',
  notes TEXT
);

CREATE TABLE shift_templates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(50) NOT NULL,
  start_time VARCHAR(10),
  end_time VARCHAR(10),
  color VARCHAR(100)
);

CREATE TABLE staff_schedules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id UUID REFERENCES users(id),
  week_start DATE NOT NULL,
  shifts JSONB NOT NULL, -- [{day, templateId, templateName, startTime, endTime}]
  status VARCHAR(20) DEFAULT 'draft',
  created_by VARCHAR(100),
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE leave_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id UUID REFERENCES users(id),
  leave_type VARCHAR(20) CHECK (leave_type IN ('sick','casual','annual','emergency')),
  start_date DATE NOT NULL,
  end_date DATE NOT NULL,
  total_days INT,
  reason TEXT,
  status VARCHAR(20) DEFAULT 'pending',
  applied_on DATE DEFAULT CURRENT_DATE,
  reviewed_by VARCHAR(100),
  reviewed_on DATE,
  review_note TEXT
);

CREATE TABLE leave_balances (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id UUID REFERENCES users(id),
  annual_total INT DEFAULT 14,
  annual_used INT DEFAULT 0,
  sick_total INT DEFAULT 8,
  sick_used INT DEFAULT 0,
  casual_total INT DEFAULT 6,
  casual_used INT DEFAULT 0
);

CREATE TABLE shifts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  shift_number VARCHAR(20) UNIQUE,
  cashier_id UUID REFERENCES users(id),
  cashier_name VARCHAR(100),
  opened_at TIMESTAMP NOT NULL,
  closed_at TIMESTAMP,
  opening_cash DECIMAL(10,2),
  closing_cash DECIMAL(10,2),
  status VARCHAR(10) DEFAULT 'open',
  total_sales DECIMAL(10,2) DEFAULT 0,
  total_cash_sales DECIMAL(10,2) DEFAULT 0,
  total_card_sales DECIMAL(10,2) DEFAULT 0,
  total_online_sales DECIMAL(10,2) DEFAULT 0,
  order_count INT DEFAULT 0,
  cancelled_orders INT DEFAULT 0,
  total_expenses DECIMAL(10,2) DEFAULT 0,
  expected_cash DECIMAL(10,2) DEFAULT 0,
  cash_difference DECIMAL(10,2),
  notes TEXT
);

-- =============================================
-- PHASE 10: Advanced
-- =============================================

CREATE TABLE deals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(100) NOT NULL,
  description TEXT,
  type VARCHAR(30) CHECK (type IN ('percentage','combo','buyXgetY','timeBased','optionCombo')),
  discount_percent DECIMAL(5,2),
  applicable_items UUID[],
  applicable_categories UUID[],
  combo_items JSONB, -- [{itemId, qty}]
  combo_price DECIMAL(10,2),
  buy_qty INT,
  get_qty INT,
  buy_item_id UUID,
  get_item_id UUID,
  start_time VARCHAR(10),
  end_time VARCHAR(10),
  time_discount_percent DECIMAL(5,2),
  option_groups JSONB, -- [{id, label, allowedItems[], maxSelections}]
  deal_price DECIMAL(10,2),
  valid_from DATE,
  valid_to VARCHAR(20), -- 'always' or date
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE coupons (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code VARCHAR(30) UNIQUE NOT NULL,
  type VARCHAR(20) CHECK (type IN ('percentage','fixed')),
  value DECIMAL(10,2) NOT NULL,
  min_order_amount DECIMAL(10,2) DEFAULT 0,
  max_discount DECIMAL(10,2),
  usage_limit INT DEFAULT 0,
  used_count INT DEFAULT 0,
  valid_from DATE,
  valid_to DATE,
  is_active BOOLEAN DEFAULT true,
  applicable_to VARCHAR(20) DEFAULT 'all',
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE reservations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_name VARCHAR(100) NOT NULL,
  customer_phone VARCHAR(20),
  date DATE NOT NULL,
  time VARCHAR(10) NOT NULL,
  guest_count INT DEFAULT 1,
  table_id UUID REFERENCES restaurant_tables(id),
  table_number VARCHAR(10),
  status VARCHAR(20) DEFAULT 'pending' CHECK (status IN ('pending','confirmed','seated','completed','cancelled','noShow')),
  special_requests TEXT,
  source VARCHAR(20) CHECK (source IN ('phone','walkin','online')),
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE restaurant_tables (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  number VARCHAR(10) UNIQUE NOT NULL,
  capacity INT DEFAULT 4,
  floor VARCHAR(50),
  shape VARCHAR(20) CHECK (shape IN ('square','round','rectangle')),
  status VARCHAR(20) DEFAULT 'available',
  current_order_id UUID,
  reservation_id UUID
);

CREATE TABLE kitchens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(100) NOT NULL,
  assigned_categories TEXT[],
  status VARCHAR(20) DEFAULT 'active'
);

CREATE TABLE sms_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  recipient VARCHAR(20),
  message TEXT,
  status VARCHAR(20),
  sent_at TIMESTAMP DEFAULT NOW()
);
```

---

## 4. Implementation Phases (Priority Order)

### Why this order?

```
Phase 1: Auth & Users       ← Everything depends on authentication
Phase 2: Settings & Outlets ← Global config needed by all modules
Phase 3: Menu Management    ← Core data for POS and orders
Phase 4: Inventory          ← Linked to menu (recipes) and ordering
Phase 5: Orders & POS       ← Core business operation (depends on 1-4)
Phase 6: Customers & Loyalty ← Linked to orders
Phase 7: Financial          ← Purchases, Expenses, Supplier dues
Phase 8: Delivery           ← Rider management (depends on orders)
Phase 9: HR & Staff         ← Attendance, Shifts, Scheduling, Leave
Phase 10: Advanced          ← Deals, Coupons, Reservations, Tables, Reports, SMS, Analytics
```

---

## Phase 1: Authentication & Users

**Priority: CRITICAL — Start here**

### Frontend Reference
- `src/contexts/AuthContext.tsx` — Login, logout, permission check
- `src/pages/Login.tsx` — Login form
- `src/pages/Users.tsx` — User CRUD
- `src/pages/Profile.tsx` — User profile
- `src/data/mock-data.ts` — 7 mock users

### API Endpoints

| Method | Endpoint            | Description                    | Auth Required |
|--------|---------------------|--------------------------------|---------------|
| POST   | `/api/auth/login`   | Login with email/password      | No            |
| POST   | `/api/auth/logout`  | Invalidate token               | Yes           |
| GET    | `/api/auth/me`      | Get current user profile       | Yes           |
| PUT    | `/api/auth/me`      | Update own profile             | Yes           |
| POST   | `/api/auth/refresh` | Refresh JWT token              | Yes           |
| GET    | `/api/users`        | List all users                 | Admin+        |
| POST   | `/api/users`        | Create user                    | Admin+        |
| PUT    | `/api/users/:id`    | Update user                    | Admin+        |
| DELETE | `/api/users/:id`    | Deactivate user                | Admin+        |

### Implementation Notes
- Current frontend uses mock user lookup (no real password check)
- Backend must add: password hashing (bcrypt), JWT tokens, refresh tokens
- Role permissions mapping should be stored in backend config, not hardcoded
- Add middleware: `authenticateToken()`, `requireRole(['Admin', 'Super Admin'])`
- `localStorage/sessionStorage` → Replace with HTTP-only cookies or Bearer tokens

---

## Phase 2: Restaurant Settings & Outlets

**Priority: HIGH — Global configuration for all modules**

### Frontend Reference
- `src/pages/Settings.tsx` — Restaurant settings, self-order config, website config, reservation config
- `src/pages/Outlets.tsx` — Multi-branch outlet management
- `src/contexts/DataContext.tsx` — `updateSettings()` function

### API Endpoints

| Method | Endpoint              | Description               |
|--------|-----------------------|---------------------------|
| GET    | `/api/settings`       | Get restaurant settings   |
| PUT    | `/api/settings`       | Update settings           |
| GET    | `/api/outlets`        | List all outlets          |
| POST   | `/api/outlets`        | Create outlet             |
| PUT    | `/api/outlets/:id`    | Update outlet             |
| DELETE | `/api/outlets/:id`    | Deactivate outlet         |

### Implementation Notes
- Settings are per-outlet (multi-branch support)
- Self-order, website, and reservation configs are JSON objects stored inside settings
- Frontend uses `updateSettings(partialObj)` — backend should support partial PATCH

---

## Phase 3: Menu Management

**Priority: HIGH — Required before POS/Orders can work**

### Frontend Reference
- `src/pages/items/page.tsx` (or items directory) — Food items CRUD
- `src/pages/items/` — Category management, modifier management
- `src/data/mock-data.ts` — 20 menu items, 9 categories, 7 modifiers
- `src/contexts/DataContext.tsx` — `foodMenuItems`, `foodCategories`, `modifiers`, `foodRecipes`

### API Endpoints

| Method | Endpoint                          | Description                    |
|--------|-----------------------------------|--------------------------------|
| GET    | `/api/menu/categories`            | List food categories           |
| POST   | `/api/menu/categories`            | Create category                |
| PUT    | `/api/menu/categories/:id`        | Update category                |
| DELETE | `/api/menu/categories/:id`        | Delete category                |
| GET    | `/api/menu/items`                 | List menu items (with variants)|
| GET    | `/api/menu/items/:id`             | Get single item with details   |
| POST   | `/api/menu/items`                 | Create menu item               |
| PUT    | `/api/menu/items/:id`             | Update menu item               |
| DELETE | `/api/menu/items/:id`             | Delete menu item               |
| PUT    | `/api/menu/items/:id/availability`| Toggle available/unavailable   |
| GET    | `/api/menu/modifiers`             | List modifiers                 |
| POST   | `/api/menu/modifiers`             | Create modifier                |
| PUT    | `/api/menu/modifiers/:id`         | Update modifier                |
| DELETE | `/api/menu/modifiers/:id`         | Delete modifier                |
| GET    | `/api/menu/recipes`               | List all recipes               |
| PUT    | `/api/menu/recipes`               | Bulk update recipes            |

### Implementation Notes
- Menu items have optional `variants` array (e.g., Small/Medium/Large with different prices)
- Food recipes link menu items to ingredients with `qty_per_unit` ratios
- `updateFoodRecipes()` on frontend replaces the entire recipes object — backend should support bulk PUT
- Categories have `displayOrder` for sorting

---

## Phase 4: Inventory & Ingredients

**Priority: HIGH — Needed for stock management and order stock deduction**

### Frontend Reference
- `src/pages/stock/` directory — Stock management pages
- `src/pages/Production.tsx` — Production tracking
- `src/pages/Transfers.tsx` — Inter-outlet stock transfers
- `src/pages/Waste.tsx` — Waste recording
- `src/contexts/DataContext.tsx` — `adjustStock()`, `ingredients`, `stockAdjustments`, `stockTakes`

### API Endpoints

| Method | Endpoint                                  | Description                       |
|--------|-------------------------------------------|-----------------------------------|
| GET    | `/api/inventory/categories`               | List ingredient categories        |
| POST   | `/api/inventory/categories`               | Create ingredient category        |
| GET    | `/api/inventory/units`                    | List ingredient units             |
| GET    | `/api/inventory/ingredients`              | List all ingredients with stock   |
| POST   | `/api/inventory/ingredients`              | Add new ingredient                |
| PUT    | `/api/inventory/ingredients/:id`          | Update ingredient details         |
| POST   | `/api/inventory/ingredients/:id/adjust`   | Adjust stock (+/-)                |
| GET    | `/api/inventory/ingredients/low-stock`    | Get low stock alerts              |
| GET    | `/api/inventory/pre-made`                 | List pre-made food items          |
| POST   | `/api/inventory/pre-made`                 | Add pre-made item                 |
| PUT    | `/api/inventory/pre-made/:id`             | Update pre-made item              |
| GET    | `/api/inventory/stock-takes`              | List stock take sessions          |
| POST   | `/api/inventory/stock-takes`              | Start new stock take              |
| PUT    | `/api/inventory/stock-takes/:id`          | Update/complete stock take        |
| GET    | `/api/inventory/adjustments`              | Stock adjustment history          |
| POST   | `/api/inventory/adjustments`              | Add stock adjustment              |
| GET    | `/api/production`                         | List productions                  |
| POST   | `/api/production`                         | Add production record             |
| GET    | `/api/transfers`                          | List transfers                    |
| POST   | `/api/transfers`                          | Create transfer                   |
| PUT    | `/api/transfers/:id`                      | Update transfer status            |
| GET    | `/api/waste`                              | List waste records                |
| POST   | `/api/waste`                              | Add waste record                  |

### Implementation Notes
- `adjustStock()` is critical — used by POS when placing orders
- `addOrder()` in DataContext auto-deducts ingredient stock based on recipes — this logic MUST be in the backend
- Stock take items track `systemQty` vs `countedQty` with variance calculation
- Transfers are between outlets — need outlet_id foreign keys

---

## Phase 5: Orders & POS

**Priority: CRITICAL — Core business operation**

### Frontend Reference
- `src/pages/POS.tsx` (~2570 lines) — Full POS terminal
- `src/pages/Sales.tsx` — Sales list/history
- `src/pages/OrderStatusBoard.tsx` — Order status display
- `src/pages/KitchenPanel.tsx` — Kitchen Display System (KDS)
- `src/pages/Kitchens.tsx` — Kitchen management
- `src/pages/WaiterPanel.tsx` — Waiter interface
- `src/pages/OnlineOrders.tsx` — Online order management

### API Endpoints

| Method | Endpoint                               | Description                          |
|--------|----------------------------------------|--------------------------------------|
| GET    | `/api/orders`                          | List orders (with filters)           |
| GET    | `/api/orders/:id`                      | Get single order with items          |
| POST   | `/api/orders`                          | Create new order (+ auto stock deduction) |
| PUT    | `/api/orders/:id`                      | Update order details                 |
| PUT    | `/api/orders/:id/status`               | Update order status                  |
| PUT    | `/api/orders/:id/cancel`               | Cancel order (with reason + audit log)|
| GET    | `/api/orders/:id/modifications`        | Get modification history             |
| POST   | `/api/orders/:id/modifications`        | Add modification log entry           |
| GET    | `/api/orders/active`                   | Get non-completed orders (for KDS)   |
| GET    | `/api/orders/kitchen`                  | Orders filtered for kitchen display  |
| GET    | `/api/orders/today`                    | Today's orders summary               |
| GET    | `/api/orders/future`                   | Scheduled/future sale orders         |
| GET    | `/api/kitchens`                        | List kitchen stations                |
| POST   | `/api/kitchens`                        | Create kitchen station               |
| PUT    | `/api/kitchens/:id`                    | Update kitchen station               |

### Critical Business Logic (Must be in Backend)
```
1. Order Creation Flow:
   - Validate items exist and are available
   - Calculate subtotal, tax (from settings), discount
   - Generate unique sequential order number (ORD-XXX)
   - Auto-deduct ingredient stock via recipes
   - Create order_items records
   - Emit WebSocket event for KDS/Order Status Board

2. Order Status Updates:
   - pending → preparing → ready → completed
   - Any status → cancelled (with reason)
   - Emit real-time events for status changes

3. Future Sale / Scheduled Orders:
   - is_future_sale=true, scheduledDate, scheduledTime
   - Track advance_payment
   - Auto-activate when scheduled time arrives (cron job)
```

### WebSocket Events (Real-time)
```
server → kitchen:   "new_order", "order_cancelled"
server → pos:       "order_status_changed"
server → waiter:    "order_ready"
server → display:   "order_status_update"
```

---

## Phase 6: Customers & Loyalty

**Priority: MEDIUM — Enhances POS experience**

### Frontend Reference
- `src/pages/Customers.tsx` — Customer list
- `src/pages/CustomerDetail.tsx` — Individual customer view
- `src/pages/CustomerDues.tsx` — Outstanding dues tracking
- `src/pages/Loyalty.tsx` — Loyalty program management
- `src/pages/CustomerDisplay.tsx` — Customer-facing display

### API Endpoints

| Method | Endpoint                                    | Description                     |
|--------|---------------------------------------------|---------------------------------|
| GET    | `/api/customers`                            | List customers (search, filter) |
| GET    | `/api/customers/:id`                        | Get customer with history       |
| POST   | `/api/customers`                            | Create customer                 |
| PUT    | `/api/customers/:id`                        | Update customer                 |
| GET    | `/api/customers/:id/orders`                 | Customer order history          |
| GET    | `/api/customers/dues`                       | Customers with outstanding dues |
| POST   | `/api/customers/:id/payment`                | Record due payment              |
| GET    | `/api/loyalty/settings`                     | Get loyalty program settings    |
| PUT    | `/api/loyalty/settings`                     | Update loyalty settings         |
| GET    | `/api/loyalty/members`                      | List loyalty members            |
| POST   | `/api/loyalty/members`                      | Add loyalty member              |
| GET    | `/api/loyalty/members/:id`                  | Member details + transactions   |
| POST   | `/api/loyalty/members/:id/earn`             | Earn points (on order)          |
| POST   | `/api/loyalty/members/:id/redeem`           | Redeem points                   |
| GET    | `/api/loyalty/rewards`                      | List available rewards          |
| POST   | `/api/loyalty/rewards`                      | Create reward                   |
| PUT    | `/api/loyalty/rewards/:id`                  | Update reward                   |
| GET    | `/api/loyalty/transactions`                 | List loyalty transactions       |

### Implementation Notes
- Customer types: walk-in, regular, corporate, vip
- Corporate customers can have `customPriceList` (e.g., "corporate-10" = 10% off)
- `outstanding_due` tracks unpaid amounts — updated on order completion and payment
- Loyalty points auto-earned per order based on `loyaltySettings.pointsPerAmount`/`amountPerPoint`
- Tier upgrades auto-calculated based on total points

---

## Phase 7: Financial Module

**Priority: MEDIUM — Business accounting**

### Frontend Reference
- `src/pages/Purchases.tsx` — Purchase order management
- `src/pages/Suppliers.tsx` — Supplier management
- `src/pages/SupplierDues.tsx` — Supplier due tracking
- `src/pages/Expenses.tsx` — Expense recording

### API Endpoints

| Method | Endpoint                            | Description                   |
|--------|-------------------------------------|-------------------------------|
| GET    | `/api/suppliers`                    | List suppliers                |
| POST   | `/api/suppliers`                    | Add supplier                  |
| PUT    | `/api/suppliers/:id`                | Update supplier               |
| GET    | `/api/suppliers/dues`               | Suppliers with outstanding dues|
| GET    | `/api/purchases`                    | List purchases                |
| POST   | `/api/purchases`                    | Create purchase order         |
| PUT    | `/api/purchases/:id`                | Update purchase               |
| POST   | `/api/purchases/:id/payment`        | Record payment against purchase|
| GET    | `/api/expenses`                     | List expenses                 |
| POST   | `/api/expenses`                     | Add expense                   |
| PUT    | `/api/expenses/:id`                 | Update expense                |
| DELETE | `/api/expenses/:id`                 | Delete expense                |

### Implementation Notes
- Purchases auto-update ingredient stock when received
- Supplier `total_due` is calculated: sum of unpaid purchase amounts
- Expense categories: Rent, Utilities, Salaries, Maintenance, Marketing, Other

---

## Phase 8: Delivery Management

**Priority: MEDIUM — Required for delivery orders**

### Frontend Reference
- `src/pages/Delivery.tsx` — Delivery tracking and rider management

### API Endpoints

| Method | Endpoint                                 | Description                  |
|--------|------------------------------------------|------------------------------|
| GET    | `/api/delivery/riders`                   | List riders                  |
| POST   | `/api/delivery/riders`                   | Add rider                    |
| PUT    | `/api/delivery/riders/:id`               | Update rider                 |
| PUT    | `/api/delivery/riders/:id/availability`  | Toggle availability          |
| GET    | `/api/delivery/assignments`              | List delivery assignments    |
| POST   | `/api/delivery/assignments`              | Assign rider to order        |
| PUT    | `/api/delivery/assignments/:id/status`   | Update delivery status       |
| GET    | `/api/delivery/active`                   | Active deliveries            |

---

## Phase 9: HR & Staff Management

**Priority: LOW — Operational but not blocking core business**

### Frontend Reference
- `src/pages/Attendance.tsx` — Check-in/out tracking
- `src/pages/Shifts.tsx` — Cash register shift management
- `src/pages/EmployeePortal.tsx` — Employee self-service portal (schedule, leave requests)
- `src/contexts/DataContext.tsx` — `shiftTemplates`, `staffSchedules`, `leaveRequests`, `leaveBalances`

### API Endpoints

| Method | Endpoint                                     | Description                      |
|--------|----------------------------------------------|----------------------------------|
| GET    | `/api/attendance`                            | List attendance records          |
| POST   | `/api/attendance/check-in`                   | Employee check-in                |
| PUT    | `/api/attendance/:id/check-out`              | Employee check-out               |
| GET    | `/api/shifts`                                | List cash register shifts        |
| POST   | `/api/shifts/open`                           | Open new shift                   |
| PUT    | `/api/shifts/:id/close`                      | Close shift with summary         |
| GET    | `/api/scheduling/templates`                  | List shift templates             |
| POST   | `/api/scheduling/templates`                  | Create shift template            |
| GET    | `/api/scheduling/schedules`                  | List staff schedules             |
| POST   | `/api/scheduling/schedules`                  | Create/publish schedule          |
| PUT    | `/api/scheduling/schedules/:id`              | Update schedule                  |
| GET    | `/api/leave/requests`                        | List leave requests              |
| POST   | `/api/leave/requests`                        | Submit leave request             |
| PUT    | `/api/leave/requests/:id/approve`            | Approve leave                    |
| PUT    | `/api/leave/requests/:id/reject`             | Reject leave                     |
| GET    | `/api/leave/balances`                        | Get leave balances               |
| GET    | `/api/leave/balances/:employeeId`            | Get specific employee balance    |

### Implementation Notes
- Shift management: tracks opening cash → sales during shift → closing cash → difference
- `expectedCash = openingCash + totalCashSales - totalExpenses`
- `cashDifference = closingCash - expectedCash`
- Leave balances auto-update when leave is approved

---

## Phase 10: Advanced Features

**Priority: LOW — Nice-to-have features**

### Frontend Reference
- `src/pages/Deals.tsx` — Promotional deals management
- `src/pages/Coupons.tsx` — Coupon code management
- `src/pages/Reservations.tsx` — Table reservations
- `src/pages/TableLayout.tsx` — Visual table layout manager
- `src/pages/SelfOrder.tsx` — Self-order kiosk interface
- `src/pages/Reports.tsx` — Reports and analytics
- `src/pages/Analytics.tsx` — Dashboard analytics
- `src/pages/SMS.tsx` — SMS notifications
- `src/pages/Dashboard.tsx` — Main dashboard with charts

### API Endpoints

| Method | Endpoint                                 | Description                    |
|--------|------------------------------------------|--------------------------------|
| GET    | `/api/deals`                             | List deals                     |
| POST   | `/api/deals`                             | Create deal                    |
| PUT    | `/api/deals/:id`                         | Update deal (including toggle) |
| DELETE | `/api/deals/:id`                         | Delete deal                    |
| POST   | `/api/deals/validate`                    | Validate deal for order        |
| GET    | `/api/coupons`                           | List coupons                   |
| POST   | `/api/coupons`                           | Create coupon                  |
| PUT    | `/api/coupons/:id`                       | Update coupon                  |
| POST   | `/api/coupons/validate`                  | Validate coupon code           |
| GET    | `/api/reservations`                      | List reservations              |
| POST   | `/api/reservations`                      | Create reservation             |
| PUT    | `/api/reservations/:id`                  | Update reservation             |
| PUT    | `/api/reservations/:id/status`           | Change reservation status      |
| GET    | `/api/tables`                            | List restaurant tables         |
| POST   | `/api/tables`                            | Add table                      |
| PUT    | `/api/tables/:id`                        | Update table                   |
| PUT    | `/api/tables/:id/status`                 | Change table status            |
| GET    | `/api/reports/sales`                     | Sales report                   |
| GET    | `/api/reports/inventory`                 | Inventory report               |
| GET    | `/api/reports/financial`                 | Financial summary              |
| GET    | `/api/reports/staff`                     | Staff performance              |
| GET    | `/api/analytics/dashboard`               | Dashboard KPIs                 |
| GET    | `/api/analytics/revenue-chart`           | Revenue chart data             |
| GET    | `/api/analytics/order-types`             | Order type breakdown           |
| POST   | `/api/sms/send`                          | Send SMS                       |
| GET    | `/api/sms/history`                       | SMS history                    |
| GET    | `/api/self-order/menu`                   | Public menu (no auth)          |
| POST   | `/api/self-order/place`                  | Place order from kiosk         |

---

## Frontend Integration Guide

### Step 1: Create API Service Layer

Create `src/services/api.ts`:
```typescript
const API_BASE = import.meta.env.VITE_API_URL || 'http://localhost:3001/api';

async function request(endpoint: string, options: RequestInit = {}) {
  const token = localStorage.getItem('auth_token');
  const res = await fetch(`${API_BASE}${endpoint}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(token && { Authorization: `Bearer ${token}` }),
      ...options.headers,
    },
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export const api = {
  get: (url: string) => request(url),
  post: (url: string, data: any) => request(url, { method: 'POST', body: JSON.stringify(data) }),
  put: (url: string, data: any) => request(url, { method: 'PUT', body: JSON.stringify(data) }),
  delete: (url: string) => request(url, { method: 'DELETE' }),
};
```

### Step 2: Migration Strategy

Replace DataContext one module at a time:

1. **Phase 1**: Replace `AuthContext.tsx` to use `/api/auth/*` endpoints
2. **Phase 2**: Replace `settings` and `outlets` in DataContext with API calls
3. **Phase 3**: Replace `foodMenuItems`, `foodCategories`, `modifiers`, `foodRecipes`
4. **Phase 4**: Replace `ingredients`, `stockAdjustments`, `stockTakes`, etc.
5. **Phase 5**: Replace `orders` (this is the biggest change — real-time WebSocket needed)
6. Continue for remaining phases...

### Step 3: Keep DataContext as Cache Layer

During migration, DataContext can serve as a local cache:
```
API Call → Update DataContext state → Components re-render
                ↑
         On app load, fetch from API instead of localStorage
```

---

## Quick Start Checklist

```
[ ] Initialize Node.js project: npm init
[ ] Install dependencies: express, prisma, @prisma/client, jsonwebtoken, bcryptjs, cors, dotenv
[ ] Set up PostgreSQL database
[ ] Configure Prisma schema from the SQL above
[ ] Run prisma migrate to create tables
[ ] Implement Phase 1 (Auth) — login endpoint + JWT middleware
[ ] Seed database with mock data from mock-data.ts
[ ] Test with frontend by updating AuthContext first
[ ] Proceed phase by phase
```

---

## Summary: Collection → Table Mapping

| # | Frontend Collection       | Backend Table(s)                         | Phase |
|---|---------------------------|------------------------------------------|-------|
| 1 | users                     | users                                    | 1     |
| 2 | outlets                   | outlets                                  | 2     |
| 3 | settings                  | settings                                 | 2     |
| 4 | foodCategories            | food_categories                          | 3     |
| 5 | foodMenuItems             | food_menu_items + food_menu_variants      | 3     |
| 6 | modifiers                 | modifiers                                | 3     |
| 7 | foodRecipes               | food_recipes                             | 3     |
| 8 | ingredientCategories      | ingredient_categories                    | 4     |
| 9 | ingredientUnits           | ingredient_units                         | 4     |
| 10| ingredients               | ingredients                              | 4     |
| 11| preMadeFood               | pre_made_food                            | 4     |
| 12| stockAdjustments          | stock_adjustments                        | 4     |
| 13| stockTakes                | stock_takes + stock_take_items           | 4     |
| 14| productions               | productions                              | 4     |
| 15| transfers                 | transfers                                | 4     |
| 16| wasteRecords              | waste_records                            | 4     |
| 17| orders                    | orders + order_items + order_modification_logs | 5  |
| 18| kitchens                  | kitchens                                 | 5     |
| 19| customers                 | customers                                | 6     |
| 20| loyaltySettings           | loyalty_settings                         | 6     |
| 21| loyaltyMembers            | loyalty_members                          | 6     |
| 22| loyaltyRewards            | loyalty_rewards                          | 6     |
| 23| loyaltyTransactions       | loyalty_transactions                     | 6     |
| 24| suppliers                 | suppliers                                | 7     |
| 25| purchases                 | purchases                                | 7     |
| 26| expenses                  | expenses                                 | 7     |
| 27| riders                    | delivery_riders                          | 8     |
| 28| deliveryAssignments       | delivery_assignments                     | 8     |
| 29| attendance                | attendance                               | 9     |
| 30| shifts                    | shifts                                   | 9     |
| 31| shiftTemplates            | shift_templates                          | 9     |
| 32| staffSchedules            | staff_schedules                          | 9     |
| 33| leaveRequests             | leave_requests                           | 9     |
| 34| leaveBalances             | leave_balances                           | 9     |
| 35| deals                     | deals                                    | 10    |
| 36| coupons                   | coupons                                  | 10    |
| 37| reservations              | reservations                             | 10    |
| 38| tables                    | restaurant_tables                        | 10    |
| 39| smsHistory                | sms_history                              | 10    |
| 40| revenueChartData          | Computed from orders (no table needed)   | 10    |
| 41| orderTypeData             | Computed from orders (no table needed)   | 10    |

---

*Generated on 2026-03-16 | Based on complete frontend codebase scan of Ovenisto POS System*
