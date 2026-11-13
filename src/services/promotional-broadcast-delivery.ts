import type { Context } from 'grammy';

export type PromotionalBroadcastMedia = { type: 'photo' | 'video'; fileId: string };

export type PromotionalBroadcastDelivery =
  | { kind: 'delivered' }
  | { kind: 'skipped' }
  | { kind: 'partial'; error?: unknown; reason?: 'consent_revoked' }
  | { kind: 'failed'; error: unknown };

/**
 * Consent is checked immediately before every Telegram API call. Long text with
 * media is a second message, so a failed text call leaves a partial delivery.
 */
export async function sendPromotionalBroadcastContent(
  api: Context['api'],
  telegramId: string,
  text: string,
  media: PromotionalBroadcastMedia[],
  hasConsent: () => Promise<boolean>,
): Promise<PromotionalBroadcastDelivery> {
  if (!(await hasConsent())) return { kind: 'skipped' };

  if (media.length === 0) {
    try {
      await api.sendMessage(telegramId, text);
      return { kind: 'delivered' };
    } catch (error) {
      return { kind: 'failed', error };
    }
  }

  const caption = text.length <= 1024 ? text : undefined;
  try {
    if (media.length === 1) {
      const item = media[0]!;
      if (item.type === 'photo') await api.sendPhoto(telegramId, item.fileId, caption ? { caption } : {});
      else await api.sendVideo(telegramId, item.fileId, caption ? { caption } : {});
    } else {
      await api.sendMediaGroup(telegramId, media.map((item, index) => ({
        type: item.type,
        media: item.fileId,
        ...(index === 0 && caption ? { caption } : {}),
      })));
    }
  } catch (error) {
    return { kind: 'failed', error };
  }

  if (caption) return { kind: 'delivered' };
  if (!(await hasConsent())) return { kind: 'partial', reason: 'consent_revoked' };
  try {
    await api.sendMessage(telegramId, text);
    return { kind: 'delivered' };
  } catch (error) {
    return { kind: 'partial', error };
  }
}
