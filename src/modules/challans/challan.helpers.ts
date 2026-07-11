/**
 * Pure settlement-math for Main→Branch transfer receiving. No I/O — see
 * challan.controller.ts's receiveChallan for how this is wired to Prisma.
 */

export interface ChallanSettlementItemInput {
  qty: number;
  unitPrice: number;
}

export interface ChallanSettlementInput {
  items: ChallanSettlementItemInput[];
  tax: number;
  shippingCost: number;
  miscAmount: number;
  paid: number;
}

export interface ChallanSettlementResult {
  subtotal: number;
  total: number;
  due: number;
  paymentStatus: 'paid' | 'partial' | 'unpaid';
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export function computeChallanSettlement(input: ChallanSettlementInput): ChallanSettlementResult {
  const subtotal = round2(input.items.reduce((sum, item) => sum + item.qty * item.unitPrice, 0));
  const total = round2(subtotal + input.tax + input.shippingCost + input.miscAmount);
  const due = Math.max(0, round2(total - input.paid));
  const paymentStatus: ChallanSettlementResult['paymentStatus'] =
    due <= 0 ? 'paid' : input.paid > 0 ? 'partial' : 'unpaid';
  return { subtotal, total, due, paymentStatus };
}
