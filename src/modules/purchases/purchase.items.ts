/** Returns the first problem with a purchase's line items, or null when they are fine.
 *  qty must be positive, wasteQty between 0 and qty, unitPrice not negative — otherwise
 *  receivedQty (qty − wasteQty) goes negative and a "purchase" silently removes stock. */
export function invalidPurchaseItem(items: Array<Record<string, unknown>>): string | null {
  for (const item of items) {
    const label = String(item.name ?? item.ingredientId ?? 'item');
    const qty = Number(item.qty);
    const wasteQty = Number(item.wasteQty ?? 0);
    const unitPrice = Number(item.unitPrice ?? 0);
    if (!Number.isFinite(qty) || qty <= 0) return `Quantity for "${label}" must be greater than 0`;
    if (!Number.isFinite(wasteQty) || wasteQty < 0 || wasteQty > qty) {
      return `Waste quantity for "${label}" must be between 0 and the purchased quantity`;
    }
    if (!Number.isFinite(unitPrice) || unitPrice < 0) return `Unit price for "${label}" cannot be negative`;
  }
  return null;
}

/** Returns the first problem with a purchase's payment fields, or null when they are fine.
 *  Total cannot be negative, paid must be between 0 and the total, and status must be one
 *  the due maths understands — otherwise a supplier's balance can go negative. */
export function invalidPurchasePayment(total: unknown, paid: unknown, status: unknown): string | null {
  const t = Number(total);
  const p = Number(paid ?? 0);
  if (!Number.isFinite(t) || t < 0) return 'Total cannot be negative';
  if (!Number.isFinite(p) || p < 0) return 'Paid amount cannot be negative';
  if (p > t) return 'Paid amount cannot be more than the total';
  if (!['paid', 'unpaid', 'partial'].includes(String(status))) return 'Payment status must be paid, unpaid or partial';
  return null;
}
