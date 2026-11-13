import 'dotenv/config';
import type { PaymentMethod } from '../types/payment.ts';

function loadPaymentMethods(): PaymentMethod[] {
  const configured = process.env.PAYMENT_METHODS?.trim();
  if (configured) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(configured);
    } catch {
      throw new Error('PAYMENT_METHODS must be a JSON array of { id, title, instructions }.');
    }
    if (!Array.isArray(parsed)) throw new Error('PAYMENT_METHODS must be a JSON array.');
    const methods = parsed.map((item, index) => {
      if (!item || typeof item !== 'object') throw new Error(`Invalid PAYMENT_METHODS item at index ${index}.`);
      const { id, title, instructions } = item as Record<string, unknown>;
      if (typeof id !== 'string' || !['ru_card', 'fr_bank'].includes(id)
        || typeof title !== 'string' || !title.trim()
        || typeof instructions !== 'string' || !instructions.trim()) {
        throw new Error(`PAYMENT_METHODS item ${index} must use id "ru_card" or "fr_bank" and include a title and transfer instructions.`);
      }
      return { id, title: title.trim(), instructions: instructions.trim() };
    });
    if (new Set(methods.map((method) => method.id)).size !== methods.length) {
      throw new Error('PAYMENT_METHODS ids must be unique.');
    }
    if (!methods.some((method) => method.id === 'ru_card') || !methods.some((method) => method.id === 'fr_bank')) {
      throw new Error('PAYMENT_METHODS must include both ru_card and fr_bank transfer instructions.');
    }
    return methods;
  }
  return [];
}

function getRequiredEnv(name: string): string {
  const value = process.env[name]?.trim();

  if (!value) {
    throw new Error(`Required environment variable ${name} is not set.`);
  }

  return value;
}

export const config = {
  apiToken: getRequiredEnv('API_TOKEN'),
  databaseUrl: getRequiredEnv('DATABASE_URL'),
  paymentMethods: loadPaymentMethods(),
  adminTelegramIds: (process.env.ADMIN_TELEGRAM_IDS ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)
    .map((value) => {
      if (!/^\d+$/.test(value)) {
        throw new Error(`Invalid Telegram ID in ADMIN_TELEGRAM_IDS: ${value}`);
      }

      return value;
    }),
};
