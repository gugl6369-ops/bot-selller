import { randomBytes } from 'node:crypto';

/** 96 bits of entropy encoded as 16 base64url characters for Telegram callback_data. */
export function createPromotionalBroadcastDraftToken(): string {
  return randomBytes(12).toString('base64url');
}
