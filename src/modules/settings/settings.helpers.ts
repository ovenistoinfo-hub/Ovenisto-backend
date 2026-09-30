export const DEFAULT_PAYMENT_METHODS = ['Cash', 'Credit Card', 'Account', 'JazzCash', 'EasyPaisa'];

export function mergePaymentMethods(lists: string[][]): string[] {
  let hasCash = false;
  let firstCashStr = 'Cash';
  for (const list of lists) {
    for (const m of list) {
      if (m.toLowerCase() === 'cash') {
        hasCash = true;
        firstCashStr = m;
        break;
      }
    }
    if (hasCash) break;
  }

  const merged: string[] = [];
  const seen = new Set<string>();

  const add = (method: string) => {
    const lower = method.toLowerCase();
    if (!seen.has(lower)) {
      seen.add(lower);
      merged.push(method);
    }
  };

  if (hasCash) {
    add(firstCashStr);
  }

  for (const list of lists) {
    for (const m of list) {
      add(m);
    }
  }

  if (merged.length === 0) return DEFAULT_PAYMENT_METHODS;
  return merged;
}

