import { Bot, InlineKeyboard, type Context } from 'grammy';
import type { AdvertiserRepository } from '../../../db/repositories/advertiser-repository.ts';
import { AdvertiserService } from '../../../services/advertiser-service.ts';
import { OrderService } from '../../../services/order-service.ts';
import type { StartService } from '../../../services/start-service.ts';
import type { UserPreferenceKey, UserPreferences } from '../../../types/user.ts';
import type { AdminRepository } from '../../../db/repositories/admin-repository.ts';
import type { OrderMaterialService } from '../../../services/order-material-service.ts';
import {
  menuKeyboard,
  isAdvertiser,
  beginQuestion,
  beginOnboarding,
  startTextFlow,
  backButton,
  sendInquiryToAdmins,
  sendDataDeletionRequestToAdmins,
  sendMaterialPromptWithReuseOffer,
} from './presentation.ts';
import { DATA_DELETION_INQUIRY_TOPIC } from '../../../services/inquiry-topics.ts';
import { notificationConsentKeyboard, notificationConsentText } from '../../keyboards/notification-consent.ts';

const preferenceLabels: Record<UserPreferenceKey, string> = {
  monthlyPromotions: 'Ежемесячные рекламные предложения',
  applicationReminders: 'Напоминания по незавершённой заявке',
  repeatPlacementMessages: 'Сообщения о повторном размещении',
  feedbackRequests: 'Запрос отзыва о результате размещения',
};

function settingsText(): string {
  return 'Настройки сообщений. Включайте только нужное. Сервисные уведомления о заказах останутся включены.';
}

function settingsKeyboard(preferences: UserPreferences): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  for (const key of Object.keys(preferenceLabels) as UserPreferenceKey[]) {
    const enabled = preferences[key];
    keyboard.text(
      `${enabled ? '✅' : '🔕'} ${preferenceLabels[key]}: ${enabled ? 'Вкл.' : 'Выкл.'}`,
      `user:settings:toggle:${key}`,
    ).row();
  }
  return keyboard
    .text('🔕 Отключить все рекламные сообщения', 'user:settings:unsubscribe').row()
    .text('Изменить контактные данные', 'user:settings:contact').row()
    .text('Запросить удаление данных', 'user:settings:delete');
}

async function showReferralProgram(
  ctx: Context,
  advertisers: AdvertiserRepository,
  service: AdvertiserService,
  orderService: OrderService,
): Promise<void> {
  const sender = ctx.from;
  if (!sender) return;
  await service.cancel(String(sender.id));
  await orderService.cancel(String(sender.id));
  const stats = await advertisers.getReferralStats(String(sender.id));
  const username = ctx.me.username;
  const link = username
    ? `https://t.me/${username}?start=${stats.referralCode}`
    : `Код приглашения: ${stats.referralCode}`;
  await ctx.reply([
    'Порекомендуйте нашу рекламу другому бизнесу.',
    `Бонус за первую подтверждённую оплату приглашённого рекламодателя: ${stats.bonusOffer}.`,
    '',
    `Ваша ссылка: ${link}`,
    `Переходы по ссылке: ${stats.clicks}`,
    `Зарегистрировались: ${stats.referrals}`,
    `Заявки: ${stats.applications}`,
    `Оплаченные рекомендации: ${stats.paidReferrals}`,
    `Доступно бонусов: ${stats.earnedBonuses}`,
    `Использовано бонусов: ${stats.usedBonuses}`,
  ].join('\n'), {
    reply_markup: new InlineKeyboard().text('Назад к настройкам', 'user:settings:back'),
  });
}

export function registerProfileHandlers(bot: Bot, advertisers: AdvertiserRepository, service: AdvertiserService, startService: StartService, orderService: OrderService, adminRepository: AdminRepository, materialService: OrderMaterialService): void {
  bot.callbackQuery(/^user:consent:(marketing|feedback):(yes|no)$/, async (ctx) => {
    const sender = ctx.from;
    if (!sender || !(await isAdvertiser(ctx, startService))) return;
    const [, , category, answer] = ctx.callbackQuery.data.split(':');
    if (category !== 'marketing' && category !== 'feedback') return;
    const enabled = answer === 'yes';
    const preferences = category === 'marketing'
      ? await startService.setMarketingConsent(String(sender.id), enabled)
      : await startService.setFeedbackConsent(String(sender.id), enabled);
    const answered = await startService.markPendingConsentAnswered(String(sender.id), category);
    const consentAnswers = answered ?? {
      marketingAnswered: category === 'marketing',
      feedbackAnswered: category === 'feedback',
    };
    try {
      await ctx.editMessageText(notificationConsentText(preferences, {
        marketing: consentAnswers.marketingAnswered,
        feedback: consentAnswers.feedbackAnswered,
      }), {
        reply_markup: notificationConsentKeyboard(preferences, {
          marketing: consentAnswers.marketingAnswered,
          feedback: consentAnswers.feedbackAnswered,
        }),
      });
    } catch (error) {
      const description = typeof error === 'object' && error !== null && 'description' in error
        ? String(error.description)
        : error instanceof Error ? error.message : String(error);
      if (!description.includes('message is not modified')) throw error;
    }
    await ctx.answerCallbackQuery({ text: enabled ? 'Согласие сохранено.' : 'Выбор сохранён.' });
  });

  bot.callbackQuery('user:consent:continue', async (ctx) => {
    const sender = ctx.from;
    if (!sender || !(await isAdvertiser(ctx, startService))) return;
    const telegramId = String(sender.id);
    const orderId = await startService.getPendingConsentOrder(telegramId);
    await startService.clearPendingConsentOrder(telegramId);
    await ctx.editMessageText('Спасибо! Выбор сохранён. Его можно изменить в настройках.', {
      reply_markup: new InlineKeyboard(),
    });
    await ctx.answerCallbackQuery();
    if (orderId) {
      const activeMaterialState = await materialService.current(telegramId);
      if (activeMaterialState?.orderId === orderId) return;
      const materialState = await materialService.startAfterPayment(orderId);
      if (materialState?.status === 'collecting') {
        const chatId = ctx.chat?.id;
        if (chatId) await sendMaterialPromptWithReuseOffer(ctx.api, chatId, materialState, materialService);
        return;
      }
      if (materialState?.status === 'submitted' || materialState?.status === 'approved') return;
      await ctx.reply('Не удалось открыть передачу материалов. Откройте заказ в разделе «Мои заказы» или напишите администратору.');
    }
  });

  bot.hears('Реферальная программа', async (ctx) => {
    if (!(await isAdvertiser(ctx, startService))) return;
    await showReferralProgram(ctx, advertisers, service, orderService);
  });

  bot.callbackQuery('user:settings:referrals', async (ctx) => {
    if (!(await isAdvertiser(ctx, startService))) return;
    await showReferralProgram(ctx, advertisers, service, orderService);
  });

  bot.hears('Задать вопрос', async (ctx) => {
    if (!(await isAdvertiser(ctx, startService))) return;
    const sender = ctx.from;
    if (sender) {
      await service.cancel(String(sender.id));
      await orderService.cancel(String(sender.id));
    }
    await beginQuestion(ctx);
  });

  bot.hears('Настройки', async (ctx) => {
    if (!(await isAdvertiser(ctx, startService))) return;
    const sender = ctx.from;
    if (!sender) return;
    const preferences = await startService.getPreferences(String(sender.id));
    await ctx.reply(settingsText(), {
      reply_markup: settingsKeyboard(preferences),
    });
  });

  bot.callbackQuery(/^user:settings:toggle:/, async (ctx) => {
    const sender = ctx.from;
    if (!sender || !(await isAdvertiser(ctx, startService))) return;
    const preference = ctx.callbackQuery.data.slice('user:settings:toggle:'.length) as UserPreferenceKey;
    if (!Object.hasOwn(preferenceLabels, preference)) return;
    const preferences = await startService.togglePreference(String(sender.id), preference);
    await ctx.editMessageText(settingsText(), { reply_markup: settingsKeyboard(preferences) });
  });

  bot.callbackQuery('user:settings:unsubscribe', async (ctx) => {
    const sender = ctx.from;
    if (!sender || !(await isAdvertiser(ctx, startService))) return;
    const preferences = await startService.disableAdvertisingMessages(String(sender.id));
    await ctx.editMessageText('Все рекламные сообщения отключены. Сервисные сообщения по заказам продолжат приходить. Вы можете снова включить нужные типы сообщений в настройках.', {
      reply_markup: settingsKeyboard(preferences),
    });
  });

  bot.callbackQuery('user:settings:contact', async (ctx) => {
    const sender = ctx.from;
    if (!sender || !(await isAdvertiser(ctx, startService))) return;
    await service.cancel(String(sender.id));
    await orderService.cancel(String(sender.id));
    const prompt = await service.startContactUpdate(String(sender.id));
    await startTextFlow(ctx, prompt);
  });

  bot.callbackQuery('user:settings:delete', async (ctx) => {
    if (!(await isAdvertiser(ctx, startService))) return;
    await ctx.editMessageText('Отправить администраторам запрос на удаление ваших данных? Это создаст обращение, после обработки которого администратор свяжется с вами.', {
      reply_markup: new InlineKeyboard()
        .text('Подтвердить запрос', 'user:settings:delete:confirm')
        .text('Отмена', 'user:settings:back'),
    });
  });

  bot.callbackQuery('user:settings:delete:confirm', async (ctx) => {
    const sender = ctx.from;
    if (!sender || !(await isAdvertiser(ctx, startService))) return;
    await startService.disableAdvertisingMessages(String(sender.id));
    const inquiry = await advertisers.createInquiry(
      String(sender.id),
      DATA_DELETION_INQUIRY_TOPIC,
      'Пользователь запросил удаление своих данных из бота.',
    );
    const delivered = await sendInquiryToAdmins(ctx, inquiry, adminRepository);
    const notified = await sendDataDeletionRequestToAdmins(ctx, inquiry);
    await ctx.editMessageText(delivered || notified
      ? 'Запрос на удаление данных сохранён и передан администраторам.'
      : 'Запрос на удаление данных сохранён. Администраторы ещё не настроены или сейчас недоступны.');
  });

  bot.callbackQuery('user:settings:back', async (ctx) => {
    if (!(await isAdvertiser(ctx, startService))) return;
    await ctx.reply('Главное меню:', { reply_markup: await menuKeyboard(ctx, startService) });
  });
  bot.callbackQuery('open_question_topics', async (ctx) => {
    if (!(await isAdvertiser(ctx, startService))) return;
    const sender = ctx.from;
    if (sender) {
      await service.cancel(String(sender.id));
      await orderService.cancel(String(sender.id));
    }
    await beginQuestion(ctx);
  });

  bot.callbackQuery('start_onboarding', async (ctx) => {
    if (!(await isAdvertiser(ctx, startService))) return;
    await beginOnboarding(ctx, service, startService, advertisers, orderService);
  });

  bot.callbackQuery(/^question:/, async (ctx) => {
    const sender = ctx.from;
    if (!sender) return;
    if (!(await isAdvertiser(ctx, startService))) return;

    const topicId = ctx.callbackQuery.data.slice('question:'.length);
    const prompt = await service.startQuestion(String(sender.id), topicId);
    if (prompt) await startTextFlow(ctx, prompt);
  });

  bot.callbackQuery('flow:back', async (ctx) => {
    const sender = ctx.from;
    if (!sender || !(await isAdvertiser(ctx, startService))) return;
    const previous = await service.goBack(String(sender.id));
    if (previous.kind === 'prompt') {
      await ctx.reply(previous.text, { reply_markup: backButton() });
    } else {
      await ctx.reply('Вы вернулись в меню. Выберите раздел.', {
        reply_markup: await menuKeyboard(ctx, startService),
      });
    }
  });


}
