# Supplier & Ingredient Scoping Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Scope `Supplier` and `Ingredient` records to the Main Warehouse (Super Admin) or specific branches (Outlet Admins/Managers) so each branch manages its own vendors and ingredient list.

**Architecture:** Update the database models to add `outletId` (nullable, representing central scope when null), and filter reading/writing controllers on the backend to enforce scoping based on user roles and permissions.

**Tech Stack:** Node.js, TypeScript, Prisma, Express, Vitest

## Global Constraints
- Existing records in database without `outletId` will automatically be mapped to `null` (Main Warehouse/Super Admin scope).
- Non-Super Admins can only view and manage suppliers and ingredients belonging to their respective branch (`outletId`).
- Super Admins can only view and manage central suppliers and ingredients (`outletId: null`).

---

### Task 1: Database Schema Modifications

**Files:**
- Modify: `prisma/schema.prisma`

**Interfaces:**
- Consumes: None
- Produces: Updated database tables `suppliers` and `ingredients` with `outletId` column.

- [ ] **Step 1: Modify `prisma/schema.prisma` to add relations**
  
  Add `outletId` field and relation to `Supplier` and `Ingredient` models, and update `Outlet` with back-relations.
  
  ```prisma
  model Supplier {
    id             String   @id @default(uuid())
    name           String   @db.VarChar(100)
    company        String?  @db.VarChar(100)
    phone          String?  @db.VarChar(20)
    email          String?  @db.VarChar(100)
    totalPurchases Decimal  @default(0) @db.Decimal(12, 2)
    totalDue       Decimal  @default(0) @db.Decimal(10, 2)
    createdAt      DateTime @default(now())
    outletId       String?

    // Relations
    outlet           Outlet?           @relation(fields: [outletId], references: [id])
    purchases        Purchase[]
    ingredients      Ingredient[]
    purchaseRequests PurchaseRequest[]
    purchasePayments PurchasePayment[]

    @@map("suppliers")
  }

  model Ingredient {
    id             String   @id @default(uuid())
    name           String   @db.VarChar(100)
    brand          String?  @db.VarChar(100)
    categoryId     String?
    unitId         String?
    purchasePrice  Decimal? @db.Decimal(10, 2)
    currentStock   Decimal  @default(0) @db.Decimal(10, 3)
    lowStockLevel  Decimal  @default(0) @db.Decimal(10, 3)
    status         String   @default("active") @db.VarChar(20)
    shelfLifeHours Int?
    supplierId     String?
    outletId       String?

    // Relations
    outlet               Outlet?               @relation(fields: [outletId], references: [id])
    category             IngredientCategory?   @relation(fields: [categoryId], references: [id])
    unit                 IngredientUnit?       @relation(fields: [unitId], references: [id])
    supplier             Supplier?             @relation(fields: [supplierId], references: [id])
    recipes              FoodRecipe[]
    stockAdjustments     StockAdjustment[]
    stockTakeItems       StockTakeItem[]
    warehouseStock       WarehouseStock[]
    challanItems         StockChallanItem[]
    demandItems          StockDemandItem[]
    purchaseRequestItems PurchaseRequestItem[]
    stockBatches         StockBatch[]

    @@map("ingredients")
  }
  ```

  And add the fields to the `Outlet` model:
  
  ```prisma
  model Outlet {
    // ... other fields ...
    suppliers        Supplier[]
    ingredients      Ingredient[]
  }
  ```

- [ ] **Step 2: Apply the Prisma schema changes to the database**
  
  Run: `npx prisma db push --accept-data-loss` (or migrate if needed)
  Expected: Successful schema synchronization.

- [ ] **Step 3: Commit database schema changes**
  
  ```bash
  git add prisma/schema.prisma
  git commit -m "db: add outletId to Supplier and Ingredient models"
  ```

---

### Task 2: Backend Supplier Scoping

**Files:**
- Modify: `src/modules/suppliers/supplier.controller.ts`

**Interfaces:**
- Consumes: Database schema from Task 1.
- Produces: Scoped API actions for `getSuppliers`, `getSupplier`, `createSupplier`, `updateSupplier`, `deleteSupplier`, `recordPayment`, `getSupplierIngredients`, and `getSupplierLedger`.

- [ ] **Step 1: Add a scoping utility and update CRUD in `supplier.controller.ts`**
  
  Define `checkSupplierAccess` and update the read/write handlers to set/validate `outletId`:
  
  ```typescript
  import { resolveOutletScope } from '../../middleware/outletScope.js';

  function checkSupplierAccess(req: Request, supplierOutletId: string | null) {
    if (req.user?.role === 'Super Admin') {
      if (supplierOutletId !== null) {
        throw new ApiError('Supplier not found', 404);
      }
    } else {
      const scope = resolveOutletScope(req);
      if (scope && supplierOutletId !== scope) {
        throw new ApiError('Supplier not found', 404);
      }
    }
  }

  // Update getSuppliers query
  export const getSuppliers = asyncHandler(async (req: Request, res: Response) => {
    const { search } = req.query as Record<string, string>;

    const where: any = {};
    if (search) {
      where.OR = [
        { name: { contains: search, mode: 'insensitive' } },
        { company: { contains: search, mode: 'insensitive' } },
      ];
    }

    const scope = resolveOutletScope(req);
    if (req.user?.role === 'Super Admin') {
      where.outletId = null;
    } else if (scope) {
      where.outletId = scope;
    } else {
      where.outletId = 'none';
    }

    const data = await prisma.supplier.findMany({ where, orderBy: { name: 'asc' } });
    return res.json(ApiResponse.success(data.map(mapSupplier)));
  });

  // Update getSupplier logic
  export const getSupplier = asyncHandler(async (req: Request, res: Response) => {
    const s = await prisma.supplier.findUnique({ where: { id: req.params.id } });
    if (!s) throw new ApiError('Supplier not found', 404);
    checkSupplierAccess(req, s.outletId);
    return res.json(ApiResponse.success(mapSupplier(s)));
  });

  // Update createSupplier logic
  export const createSupplier = asyncHandler(async (req: Request, res: Response) => {
    const { name, company, phone, email } = req.body;
    if (!name) throw new ApiError('Name is required', 400);

    const outletId = req.user?.role === 'Super Admin' ? null : (req.user?.outletId ?? null);

    const s = await prisma.supplier.create({
      data: {
        name,
        company: company || null,
        phone: phone || null,
        email: email || null,
        outletId,
      },
    });
    return res.status(201).json(ApiResponse.created(mapSupplier(s), 'Supplier created'));
  });

  // Update updateSupplier logic
  export const updateSupplier = asyncHandler(async (req: Request, res: Response) => {
    const { name, company, phone, email } = req.body;
    const existing = await prisma.supplier.findUnique({ where: { id: req.params.id } });
    if (!existing) throw new ApiError('Supplier not found', 404);
    checkSupplierAccess(req, existing.outletId);

    const s = await prisma.supplier.update({
      where: { id: req.params.id },
      data: { name, company, phone, email },
    });
    return res.json(ApiResponse.success(mapSupplier(s), 'Supplier updated'));
  });

  // Update deleteSupplier logic
  export const deleteSupplier = asyncHandler(async (req: Request, res: Response) => {
    const s = await prisma.supplier.findUnique({ where: { id: req.params.id } });
    if (!s) throw new ApiError('Supplier not found', 404);
    checkSupplierAccess(req, s.outletId);

    if (Number(s.totalDue) > 0) {
      throw new ApiError('Cannot delete supplier with outstanding dues', 400);
    }
    await prisma.supplier.delete({ where: { id: req.params.id } });
    return res.json(ApiResponse.success(null, 'Supplier deleted'));
  });

  // Update recordPayment logic
  export const recordPayment = asyncHandler(async (req: Request, res: Response) => {
    const { amount } = req.body;
    if (!amount || Number(amount) <= 0) {
      throw new ApiError('Valid payment amount is required', 400);
    }

    const s = await prisma.supplier.findUnique({ where: { id: req.params.id } });
    if (!s) throw new ApiError('Supplier not found', 404);
    checkSupplierAccess(req, s.outletId);

    const newDue = Math.max(0, Number(s.totalDue) - Number(amount));
    const updated = await prisma.supplier.update({
      where: { id: req.params.id },
      data: { totalDue: newDue },
    });

    return res.json(ApiResponse.success(mapSupplier(updated), 'Payment recorded'));
  });

  // Update getSupplierIngredients logic
  export const getSupplierIngredients = asyncHandler(async (req: Request, res: Response) => {
    const { id } = req.params;
    const supplier = await prisma.supplier.findUnique({ where: { id } });
    if (!supplier) throw new ApiError('Supplier not found', 404);
    checkSupplierAccess(req, supplier.outletId);

    const ingredients = await prisma.ingredient.findMany({
      where: { supplierId: id, status: 'active' },
      orderBy: { name: 'asc' },
      include: {
        category: { select: { id: true, name: true } },
        unit: { select: { id: true, name: true } },
        supplier: { select: { id: true, name: true } },
      },
    });
    return res.json(ApiResponse.success(ingredients));
  });

  // Update getSupplierLedger logic
  export const getSupplierLedger = asyncHandler(async (req: Request, res: Response) => {
    const { id } = req.params;
    const supplier = await prisma.supplier.findUnique({ where: { id } });
    if (!supplier) throw new ApiError('Supplier not found', 404);
    checkSupplierAccess(req, supplier.outletId);

    // Fetch ledger entries (purchases and payments)
    const [purchases, payments] = await Promise.all([
      prisma.purchase.findMany({ where: { supplierId: id }, orderBy: { createdAt: 'desc' } }),
      prisma.purchasePayment.findMany({ where: { supplierId: id }, orderBy: { createdAt: 'desc' } }),
    ]);

    const entries = [
      ...purchases.map(p => ({ id: p.id, type: 'Purchase', date: p.createdAt, ref: p.invoiceNumber || '—', amount: Number(p.total), balance: 0 })),
      ...payments.map(p => ({ id: p.id, type: 'Payment', date: p.createdAt, ref: p.note || 'Payment', amount: -Number(p.amount), balance: Number(p.balanceAfter) })),
    ].sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

    return res.json(ApiResponse.success(entries));
  });
  ```

- [ ] **Step 2: Commit backend supplier scoping changes**
  
  ```bash
  git add src/modules/suppliers/supplier.controller.ts
  git commit -m "feat: enforce outlet scoping on Supplier controller endpoints"
  ```

---

### Task 3: Backend Ingredient Scoping

**Files:**
- Modify: `src/modules/inventory/inventory.controller.ts`

**Interfaces:**
- Consumes: Supplier scoping rules from Task 2.
- Produces: Scoped API actions for ingredients CRUD.

- [ ] **Step 1: Update `inventory.controller.ts` logic to filter ingredients by outlet**
  
  Update `getIngredients`, `getIngredient`, `createIngredient`, and `updateIngredient` functions:
  
  ```typescript
  import { resolveOutletScope } from '../../middleware/outletScope.js';

  function checkIngredientAccess(req: Request, ingredientOutletId: string | null) {
    if (req.user?.role === 'Super Admin') {
      if (ingredientOutletId !== null) {
        throw ApiError.notFound('Ingredient not found');
      }
    } else {
      const scope = resolveOutletScope(req);
      if (scope && ingredientOutletId !== scope) {
        throw ApiError.notFound('Ingredient not found');
      }
    }
  }

  // Update getIngredients listing query
  export const getIngredients = asyncHandler(async (req: Request, res: Response) => {
    const { search, categoryId, status, lowStock, page, limit } = req.query;

    const where: any = {};
    if (search) where.name = { contains: String(search), mode: 'insensitive' };
    if (categoryId) where.categoryId = String(categoryId);
    if (status) where.status = String(status);
    if (lowStock === 'true') where.AND = [{ currentStock: { lte: prisma.ingredient.fields.lowStockLevel } }];

    // Apply scoping
    const scope = resolveOutletScope(req);
    if (req.user?.role === 'Super Admin') {
      where.outletId = null;
    } else if (scope) {
      where.outletId = scope;
    } else {
      where.outletId = 'none';
    }

    const limitNum = limit !== undefined ? Math.max(1, Number(limit)) : undefined;
    const pageNum = page !== undefined ? Math.max(1, Number(page)) : 1;
    const paginate = limitNum !== undefined && lowStock !== 'true';

    if (paginate) {
      const [ingredients, total] = await Promise.all([
        prisma.ingredient.findMany({
          where,
          orderBy: [{ category: { name: 'asc' } }, { name: 'asc' }],
          include: {
            category: { select: { id: true, name: true } },
            unit: { select: { id: true, name: true } },
            supplier: { select: { id: true, name: true } },
          },
          skip: (pageNum - 1) * limitNum!,
          take: limitNum!,
        }),
        prisma.ingredient.count({ where }),
      ]);
      return res.json(ApiResponse.paginated(ingredients, pageNum, limitNum!, total));
    }

    const ingredients = await prisma.ingredient.findMany({
      where,
      orderBy: [{ category: { name: 'asc' } }, { name: 'asc' }],
      include: {
        category: { select: { id: true, name: true } },
        unit: { select: { id: true, name: true } },
        supplier: { select: { id: true, name: true } },
      },
    });

    const result = lowStock === 'true'
      ? ingredients.filter(i => Number(i.currentStock) <= Number(i.lowStockLevel))
      : ingredients;

    return res.json(ApiResponse.success(result));
  });

  // Update getIngredient detail query
  export const getIngredient = asyncHandler(async (req: Request, res: Response) => {
    const ingredient = await prisma.ingredient.findUnique({
      where: { id: req.params.id },
      include: {
        category: { select: { id: true, name: true } },
        unit: { select: { id: true, name: true } },
        supplier: { select: { id: true, name: true } },
      },
    });
    if (!ingredient) throw ApiError.notFound('Ingredient not found');
    checkIngredientAccess(req, ingredient.outletId);
    res.json(ApiResponse.success(ingredient));
  });

  // Update createIngredient logic
  export const createIngredient = asyncHandler(async (req: Request, res: Response) => {
    const { name, brand, categoryId, unitId, purchasePrice, currentStock, lowStockLevel, status, supplierId } = req.body;
    if (!name?.trim()) throw ApiError.badRequest('Ingredient name is required');

    // Scope checking for supplier if provided
    if (supplierId) {
      const supplier = await prisma.supplier.findUnique({ where: { id: supplierId } });
      if (!supplier) throw ApiError.notFound('Linked supplier not found');
      
      const scope = resolveOutletScope(req);
      if (req.user?.role === 'Super Admin') {
        if (supplier.outletId !== null) throw ApiError.badRequest('Cannot link supplier from outside scope');
      } else if (scope) {
        if (supplier.outletId !== scope) throw ApiError.badRequest('Cannot link supplier from outside scope');
      }
    }

    const outletId = req.user?.role === 'Super Admin' ? null : (req.user?.outletId ?? null);

    const ingredient = await prisma.ingredient.create({
      data: {
        name: name.trim(),
        brand: brand?.trim() || null,
        categoryId: categoryId || null,
        unitId: unitId || null,
        purchasePrice: purchasePrice ?? null,
        currentStock: currentStock ?? 0,
        lowStockLevel: lowStockLevel ?? 0,
        status: status ?? 'active',
        supplierId: supplierId || null,
        outletId,
      },
      include: {
        category: { select: { id: true, name: true } },
        unit: { select: { id: true, name: true } },
        supplier: { select: { id: true, name: true } },
      },
    });
    res.status(201).json(ApiResponse.created(ingredient, 'Ingredient created'));
  });

  // Update updateIngredient logic
  export const updateIngredient = asyncHandler(async (req: Request, res: Response) => {
    const { id } = req.params;
    const { name, brand, categoryId, unitId, purchasePrice, currentStock, lowStockLevel, status, supplierId } = req.body;

    const existing = await prisma.ingredient.findUnique({ where: { id } });
    if (!existing) throw ApiError.notFound('Ingredient not found');
    checkIngredientAccess(req, existing.outletId);

    // Scope checking for supplier if provided
    if (supplierId) {
      const supplier = await prisma.supplier.findUnique({ where: { id: supplierId } });
      if (!supplier) throw ApiError.notFound('Linked supplier not found');
      
      const scope = resolveOutletScope(req);
      if (req.user?.role === 'Super Admin') {
        if (supplier.outletId !== null) throw ApiError.badRequest('Cannot link supplier from outside scope');
      } else if (scope) {
        if (supplier.outletId !== scope) throw ApiError.badRequest('Cannot link supplier from outside scope');
      }
    }

    const ingredient = await prisma.ingredient.update({
      where: { id },
      data: {
        ...(name && { name: name.trim() }),
        brand: brand !== undefined ? (brand?.trim() || null) : undefined,
        categoryId: categoryId !== undefined ? (categoryId || null) : undefined,
        unitId: unitId !== undefined ? (unitId || null) : undefined,
        purchasePrice: purchasePrice !== undefined ? purchasePrice : undefined,
        currentStock: currentStock !== undefined ? currentStock : undefined,
        lowStockLevel: lowStockLevel !== undefined ? lowStockLevel : undefined,
        status: status !== undefined ? status : undefined,
        supplierId: supplierId !== undefined ? (supplierId || null) : undefined,
      },
      include: {
        category: { select: { id: true, name: true } },
        unit: { select: { id: true, name: true } },
        supplier: { select: { id: true, name: true } },
      },
    });
    res.json(ApiResponse.success(ingredient, 'Ingredient updated'));
  });

  // Update deleteIngredient logic (soft-delete / status to inactive)
  export const deleteIngredient = asyncHandler(async (req: Request, res: Response) => {
    const existing = await prisma.ingredient.findUnique({ where: { id: req.params.id } });
    if (!existing) throw ApiError.notFound('Ingredient not found');
    checkIngredientAccess(req, existing.outletId);

    await prisma.ingredient.update({ where: { id: req.params.id }, data: { status: 'inactive' } });
    res.json(ApiResponse.success(null, 'Ingredient deleted'));
  });
  ```

- [ ] **Step 2: Commit backend ingredient scoping changes**
  
  ```bash
  git add src/modules/inventory/inventory.controller.ts
  git commit -m "feat: enforce outlet scoping on Ingredient controller endpoints"
  ```

---

### Task 4: Verification and Testing

**Files:**
- Test: `src/modules/suppliers/__tests__/supplier.scoping.test.ts`
- Test: `src/modules/inventory/__tests__/ingredient.scoping.test.ts`

**Interfaces:**
- Consumes: Backend scoping endpoints.
- Produces: Successful unit test suite runs.

- [ ] **Step 1: Run project compilation checks to ensure everything builds correctly**
  
  Run: `npx tsc --noEmit`
  Expected: Clean compilation with 0 errors.

- [ ] **Step 2: Execute backend vitest test suite**
  
  Run: `npm run test`
  Expected: All tests pass.
