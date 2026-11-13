import { InlineKeyboard } from 'grammy';
import type { PaymentMethod } from '../../types/payment.ts';

export function paymentMethodsKeyboard(orderId: string, methods: PaymentMethod[]): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  for (const method of methods) keyboard.text(method.title, `pay:${orderId}:${method.id}`).row();
  keyboard.text('Другой способ — связаться с админом', `order:alternative:${orderId}`);
  return keyboard;
}
