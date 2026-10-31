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
