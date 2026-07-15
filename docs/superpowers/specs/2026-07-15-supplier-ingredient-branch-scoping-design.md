# Specification: Supplier & Ingredient Branch-Specific Scoping

This document specifies the technical design for introducing outlet/branch scoping to the `Supplier` and `Ingredient` models in Ovenisto. It ensures that both entities are segmented by branch (or Main Warehouse for Super Admins) so that users only see, manage, and connect vendors and ingredients that belong to their respective scope.

---

## 1. Schema Changes

We will modify `prisma/schema.prisma` to add optional `outletId` fields to both the `Supplier` and `Ingredient` models, establishing a relationship to the `Outlet` model.

### 1.1 `Supplier` Model Modifications
- Add `outletId` (String?): Scopes the supplier. An `outletId` of `null` represents central (Main Warehouse) scope.
- Add `outlet` relation to `Outlet` model.

### 1.2 `Ingredient` Model Modifications
- Add `outletId` (String?): Scopes the ingredient definition. An `outletId` of `null` represents central (Main Warehouse) scope.
- Add `outlet` relation to `Outlet` model.

---

## 2. Backend Controller Scoping & Access Control

### 2.1 Supplier Scoping (`src/modules/suppliers/supplier.controller.ts`)
- **Creation (`createSupplier`)**:
  - Automatically determine the scope based on the user's role:
    - If `Super Admin`, `outletId` is set to `null`.
    - Otherwise, set `outletId` to the logged-in user's `outletId`.
- **Listing (`getSuppliers`)**:
  - Filter results based on the caller's outlet scope:
    - If `Super Admin`, filter where `outletId: null`.
    - Otherwise, filter where `outletId: user.outletId`.
- **Individual Actions (`getSupplier`, `updateSupplier`, `deleteSupplier`, `recordPayment`, etc.)**:
  - Enforce access control to verify the target supplier falls within the user's scope. Return `404 Not Found` if there is a scope mismatch.

### 2.2 Ingredient Scoping (`src/modules/inventory/inventory.controller.ts`)
- **Creation (`createIngredient`)**:
  - Set `outletId` dynamically:
    - `Super Admin` -> `outletId: null` (Main Warehouse).
    - Branch Admins/Managers -> `outletId: user.outletId`.
  - Validate that the linked `supplierId` (if provided) is also in scope for the caller.
- **Listing (`getIngredients`)**:
  - Filter `prisma.ingredient.findMany` queries by:
    - If `Super Admin`, `outletId: null`.
    - Otherwise, `outletId: user.outletId`.
- **Individual Actions (`getIngredient`, `updateIngredient`, `deleteIngredient`)**:
  - Validate that the target ingredient's `outletId` matches the caller's scope (throw `404 Not Found` on mismatch).

---

## 3. Database Migration Strategy
- Since existing database records do not have `outletId` set, they will default to `null` on table update.
- This maps all existing suppliers and ingredients to the **Main Warehouse** (Super Admin scope) automatically, which aligns with the user's confirmation.

---

## 4. Verification Plan

### 4.1 Automated Verification
- Verify compilation of backend and frontend.
- Run the full suite of backend unit tests.

### 4.2 Manual Verification
- Log in as Super Admin and create a supplier ("Main Supplier") and an ingredient ("Main Salt"). Verify they show up only for the Super Admin.
- Log in as Branch Admin and create a supplier ("Branch Supplier A") and an ingredient ("Branch Salt"). Verify they show up only for the Branch Admin.
- Verify that when Branch Admin views ingredients, they cannot see or select "Main Supplier" or "Main Salt".
