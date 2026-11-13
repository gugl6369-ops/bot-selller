import { InlineKeyboard } from 'grammy';
import type { UserPreferences } from '../../types/user.ts';

export function notificationConsentText(
  preferences: UserPreferences,
  answered: { marketing?: boolean; feedback?: boolean } = {},
): string {
  const marketingEnabled = preferences.monthlyPromotions
    || preferences.applicationReminders
    || preferences.repeatPlacementMessages;
  const marketingAnswered = answered.marketing ?? marketingEnabled;
  const feedbackAnswered = answered.feedback ?? preferences.feedbackRequests;
  const lines = [
    '🔔 Настроим уведомления',
    '',
    'Выберите, какие сообщения вам подходят:',
    '',
    `${preferences.monthlyPromotions ? '✅' : '▫️'} Ежемесячные рекламные предложения`,
    `${preferences.applicationReminders ? '✅' : '▫️'} Напоминания по незавершённым заявкам`,
    `${preferences.repeatPlacementMessages ? '✅' : '▫️'} Сообщения о повторном размещении`,
    ...(!marketingEnabled && !marketingAnswered
      ? ['Разрешить рекламные предложения и напоминания?']
      : []),
    '',
    `${preferences.feedbackRequests ? '✅' : '▫️'} Запрос отзыва о результате рекламы после публикации`,
    ...(!preferences.feedbackRequests && !feedbackAnswered
      ? ['Разрешить запрос отзыва?']
      : []),
    '',
    'Согласие необязательно — можно продолжить без подписки.',
  ];
  if (marketingEnabled || preferences.feedbackRequests) {
    lines.push('Настройки можно изменить позже в разделе «Настройки» главного меню.');
  }
  return lines.join('\n');
}

export function notificationConsentKeyboard(
  preferences: UserPreferences,
  answered: { marketing?: boolean; feedback?: boolean } = {},
): InlineKeyboard {
  const marketingEnabled = preferences.monthlyPromotions
    || preferences.applicationReminders
    || preferences.repeatPlacementMessages;
  const keyboard = new InlineKeyboard();
  if (!marketingEnabled && !answered.marketing) {
    keyboard.text('Получать сообщения', 'user:consent:marketing:yes')
      .text('Не получать', 'user:consent:marketing:no').row();
  }
  if (!preferences.feedbackRequests && !answered.feedback) {
    keyboard.text('Разрешить запрос отзыва', 'user:consent:feedback:yes')
      .text('Без отзыва', 'user:consent:feedback:no').row();
  }
  return keyboard.text('Продолжить к материалам ➜', 'user:consent:continue');
}
