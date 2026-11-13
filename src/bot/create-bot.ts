import { Bot } from 'grammy';
import { config } from '../config/env.ts';
import type { StartService } from '../services/start-service.ts';
import type { AdvertiserRepository } from '../db/repositories/advertiser-repository.ts';
import type { AdvertiserService } from '../services/advertiser-service.ts';
import type { AdminRepository } from '../db/repositories/admin-repository.ts';
import type { AdminService } from '../services/admin-service.ts';
import type { OrderService } from '../services/order-service.ts';
import type { OrderMaterialService } from '../services/order-material-service.ts';
import { handleHelp, createStartHandler } from './handlers/index.ts';
import { registerAdminHandlers } from './handlers/admin.ts';
import { registerMenuHandlers } from './handlers/menu.ts';
import {
  PromotionalBroadcastClaimActiveError,
  PromotionalBroadcastDraftChangedError,
} from '../db/repositories/admin/flow-repository.ts';

export function createBot(
  startService: StartService,
  advertisers: AdvertiserRepository,
  advertiserService: AdvertiserService,
  adminRepository: AdminRepository,
  adminService: AdminService,
  orderService: OrderService,
  materialService: OrderMaterialService,
): Bot {
  const bot = new Bot(config.apiToken);

  const usersWithActionInProgress = new Set<number>();
  const recentlyHandledActions = new Map<string, number>();
  const replyKeyboardActions = new Set([
    'Панель администратора', 'Тарифы', 'Заявки', 'Отзывы', 'Заказы', 'Вопросы', 'Материалы', 'Платежи', 'Центр событий',
    'Рефералы', 'Статистика', 'Рассылка', 'Планы рассылок', 'Назад', 'Отменить', 'В меню', 'Посмотреть тарифы', 'Оформить рекламу',
    'Реферальная программа', 'Задать вопрос', 'Мои заявки', 'Мои заказы', 'Настройки', 'Текущие заказы',
    'История заказов', 'Удаление данных',
  ]);
  bot.use(async (ctx, next) => {
    const callback = ctx.callbackQuery;
    const sender = ctx.from;
    const broadcastBusyText = 'Рассылка уже отправляется.';
    if (sender && config.adminTelegramIds.includes(String(sender.id))) {
      const flow = await adminRepository.getFlow(String(sender.id));
      if (flow?.flowType === 'promotional_broadcast' && flow.step === 2) {
        if (callback) {
          try {
            await ctx.answerCallbackQuery({ text: broadcastBusyText });
          } catch {
            // Callback may have expired while the broadcast was running.
          }
        } else if (ctx.message) {
          await ctx.reply(broadcastBusyText);
        }
        return;
      }
    }
    const buttonText = ctx.message?.text;
    const isReplyKeyboardAction = Boolean(buttonText && replyKeyboardActions.has(buttonText));
    if ((!callback && !isReplyKeyboardAction) || !sender) return next();

    const actionKey = callback
      ? `${sender.id}:${callback.message?.chat.id ?? callback.inline_message_id ?? 'inline'}:${callback.message?.message_id ?? ''}:${callback.data}`
      : `${sender.id}:text:${buttonText}`;
    const now = Date.now();
    const recentlyHandledUntil = recentlyHandledActions.get(actionKey) ?? 0;
    if (usersWithActionInProgress.has(sender.id) || recentlyHandledUntil > now) {
      if (callback) {
        try {
          await ctx.answerCallbackQuery({ text: 'Подождите, выполняется предыдущее действие.' });
        } catch {
          // Telegram may expire an older callback query while the previous action is still running.
        }
      } else {
        await ctx.reply('Подождите, бот ещё выполняет предыдущее действие.');
      }
      return;
    }

    usersWithActionInProgress.add(sender.id);
    let broadcastClaimBlocked = false;
    try {
      await next();
    } catch (error) {
      if (!(error instanceof PromotionalBroadcastClaimActiveError)
        && !(error instanceof PromotionalBroadcastDraftChangedError)) throw error;
      broadcastClaimBlocked = true;
      const responseText = error instanceof PromotionalBroadcastDraftChangedError
        ? 'Черновик изменился, откройте текущую рассылку'
        : broadcastBusyText;
      if (callback) {
        try {
          await ctx.answerCallbackQuery({ text: responseText });
        } catch {
          // Callback may have expired while the broadcast was running.
        }
      } else {
        await ctx.reply(responseText);
      }
    } finally {
      usersWithActionInProgress.delete(sender.id);
      recentlyHandledActions.set(actionKey, Date.now() + 1200);
      for (const [key, expiresAt] of recentlyHandledActions) {
        if (expiresAt <= Date.now()) recentlyHandledActions.delete(key);
      }
      if (callback && !broadcastClaimBlocked) {
        try {
          await ctx.answerCallbackQuery();
        } catch {
          // Ignore callback queries that expired while a slow database or Telegram request was running.
        }
      }
    }
  });

  bot.command('start', createStartHandler(startService, adminRepository));
  bot.command('help', handleHelp);
  registerAdminHandlers(bot, adminRepository, adminService, startService, materialService);
  registerMenuHandlers(bot, advertisers, advertiserService, startService, orderService, materialService, adminRepository);

  bot.catch(async ({ error, ctx }) => {
    if (error instanceof PromotionalBroadcastClaimActiveError
      || error instanceof PromotionalBroadcastDraftChangedError) {
      const responseText = error instanceof PromotionalBroadcastDraftChangedError
        ? 'Черновик изменился, откройте текущую рассылку'
        : 'Рассылка уже отправляется.';
      if (ctx.callbackQuery) {
        try {
          await ctx.answerCallbackQuery({ text: responseText });
        } catch {
          // Callback may have expired while the broadcast was running.
        }
      } else if (ctx.message) {
        await ctx.reply(responseText);
      }
      return;
    }
    console.error(`Failed to handle update ${ctx.update.update_id}:`, error);
  });

  return bot;
}
