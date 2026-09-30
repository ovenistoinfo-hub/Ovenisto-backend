import { prisma } from '../../config/database.js';
import { mergePaymentMethods, DEFAULT_PAYMENT_METHODS } from './settings.helpers.js';

export async function getConfiguredPaymentMethods(outletId: string | null): Promise<string[]> {
  if (outletId) {
    const settings = await prisma.settings.findFirst({
      where: { outletId },
      select: { paymentMethods: true }
    });
    const methods = settings?.paymentMethods as string[] | undefined;
    if (!methods || methods.length === 0) return DEFAULT_PAYMENT_METHODS;
    return methods;
  } else {
    const allSettings = await prisma.settings.findMany({
      select: { paymentMethods: true }
    });
    const lists = allSettings.map(s => (s.paymentMethods as string[] | undefined) || []);
    return mergePaymentMethods(lists);
  }
}

