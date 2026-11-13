import { Bot, InlineKeyboard, type Context } from 'grammy';
import type { AdminRepository } from '../../db/repositories/admin-repository.ts';
import { AdminService } from '../../services/admin-service.ts';
import type { StartService } from '../../services/start-service.ts';
import type { OrderMaterialService } from '../../services/order-material-service.ts';
import { sendMaterialPromptTo } from './menu/presentation.ts';
import { refreshAdminInbox } from '../../services/admin-inbox-service.ts';
import { isDataDeletionInquiry } from '../../services/inquiry-topics.ts';
import { broadcastLocalDateTimeToUtc, isValidBroadcastTime, BROADCAST_TIME_ZONE } from '../../services/broadcast-scheduling.ts';
import { promotionalBroadcastPanel, registerAdminCallbackHandlers, scheduledPromotionalBroadcastsPage, showPromotionalBroadcastPreview } from './admin/callbacks.ts';
import {
  adminFlowKeyboard,
  adminMenuKeyboard,
  adminToolsKeyboard,
  displayPublicationDate,
  publicationNotificationText,
  fromAdmin,
  isAdmin,
  leadText,
  showAdminMenu,
  showDataDeletionRequests,
  showBusinessLeadMenu,
  showInquiries,
  showFeedbackMenu,
  showMaterialSubmissions,
  showPayments,
  showReferrals,
  showStatistics,
  showTariffs,
} from './admin/views.ts';

export function registerAdminHandlers(
  bot: Bot,
  repository: AdminRepository,
  service: AdminService,
  startService: StartService,
  materialService: OrderMaterialService,
): void {
  registerAdminCallbackHandlers(bot, repository, service, startService, materialService);

  bot.on('message:text', async (ctx, next) => {
    const sender = ctx.from;
    if (!sender || !(await isAdmin(ctx, startService))) return next();
    const adminId = String(sender.id);
    if (!(await repository.hasFeedbackInput(adminId))) return next();
    if (/^\/cancel(?:@\w+)?$/iu.test(ctx.message.text) || ctx.message.text === 'Назад' || ctx.message.text === 'В меню') {
      await repository.cancelFeedbackInput(adminId);
      await ctx.reply('Ответ по отзыву отменён.', { reply_markup: adminMenuKeyboard() });
      return;
    }
    const text = ctx.message.text.trim();
    if (!text) {
      await ctx.reply('Введите текст ответа рекламодателю.');
      return;
    }
    if (text.length > 3000) {
      await ctx.reply('Ответ слишком длинный. Ограничение — 3000 символов; отправьте его короче.');
      return;
    }
    const saved = await repository.completeFeedbackInput(adminId, text);
    if (!saved || saved.senderType !== 'admin') {
      await ctx.reply('Не удалось сохранить ответ. Откройте отзыв и попробуйте снова.');
      return;
    }
    await ctx.api.sendMessage(
      saved.userTelegramId,
      `✉️ Ответ администратора по обсуждению итога заказа №${saved.orderNumber}\n\n${text}`,
      { reply_markup: new InlineKeyboard().text('Ответить по отзыву', `feedback:reply:${saved.orderId}`) },
    );
    await ctx.reply(`Ответ по отзыву заказа №${saved.orderNumber} отправлен рекламодателю.`, {
      reply_markup: adminMenuKeyboard(),
    });
  });

  bot.hears('Панель администратора', async (ctx) => {
    if (!(await isAdmin(ctx, startService))) {
      await ctx.reply('У вас нет доступа к панели администратора.');
      return;
    }
    const sender = ctx.from;
    if (sender) await service.cancel(String(sender.id));
    await showAdminMenu(ctx, repository);
  });

  bot.hears('Инструменты', async (ctx) => {
    if (!(await isAdmin(ctx, startService))) return;
    const sender = ctx.from;
    if (sender) await service.cancel(String(sender.id));
    await ctx.reply('Выберите инструмент:', {
      reply_markup: adminToolsKeyboard(),
    });
  });

  bot.hears('Отзывы', async (ctx) => {
    if (!(await isAdmin(ctx, startService))) return;
    await showFeedbackMenu(ctx, repository);
  });

  bot.callbackQuery('admin:inbox:refresh', async (ctx) => {
    if (!(await isAdmin(ctx, startService))) return;
    const sender = ctx.from;
    if (sender) await refreshAdminInbox(ctx.api, repository, String(sender.id));
  });

  bot.hears('Центр событий', async (ctx) => {
    if (!(await isAdmin(ctx, startService))) return;
    const sender = ctx.from;
    if (sender) await refreshAdminInbox(ctx.api, repository, String(sender.id));
  });

  bot.callbackQuery('admin:inquiries', async (ctx) => {
    if (!(await isAdmin(ctx, startService))) return;
    await showInquiries(ctx, repository);
  });

  bot.hears('Тарифы', async (ctx) => {
    if (!(await isAdmin(ctx, startService))) return;
    const sender = ctx.from;
    if (sender) await service.cancel(String(sender.id));
    await showTariffs(ctx, repository);
  });

  bot.hears('Заявки', async (ctx) => {
    if (!(await isAdmin(ctx, startService))) return;
    const sender = ctx.from;
    if (sender) await service.cancel(String(sender.id));
    await showBusinessLeadMenu(ctx, repository);
  });

  bot.hears(/^Заказы(?: \(\d+\))?$/, async (ctx) => {
    if (!(await isAdmin(ctx, startService))) return;
    const sender = ctx.from;
    if (sender) await service.cancel(String(sender.id));
    const counts = await repository.getOrderStatusCounts();
    await ctx.reply('Выберите статус заказов:', {
      reply_markup: new InlineKeyboard()
        .text(`Ожидают решения (${counts.pendingConfirmation})`, 'admin:orders:pending_confirmation')
        .text(`Подтверждены (${counts.confirmed})`, 'admin:orders:confirmed').row()
        .text(`Отклонены (${counts.rejected})`, 'admin:orders:rejected')
        .text(`Отменены (${counts.cancelled})`, 'admin:orders:cancelled').row()
        .text(`Все заказы (${counts.total})`, 'admin:orders:all'),
    });
  });

  bot.hears(/^Вопросы(?: \(\d+\))?$/, async (ctx) => {
    if (!(await isAdmin(ctx, startService))) return;
    const sender = ctx.from;
    if (sender) await service.cancel(String(sender.id));
    await showInquiries(ctx, repository);
  });

  bot.hears('Платежи', async (ctx) => {
    if (!(await isAdmin(ctx, startService))) return;
    const sender = ctx.from;
    if (sender) await service.cancel(String(sender.id));
    await showPayments(ctx, repository);
  });

  const openBroadcastPlans = async (ctx: Context) => {
    if (!(await isAdmin(ctx, startService))) return;
    const sender = ctx.from;
    if (!sender) return;
    await service.cancel(String(sender.id));
    const page = await promotionalBroadcastPanel(repository, String(sender.id));
    await ctx.reply(page.text, { reply_markup: page.keyboard });
  };
  bot.hears('Рассылка', openBroadcastPlans);
  bot.hears('Планы рассылок', openBroadcastPlans);

  bot.hears('Материалы', async (ctx) => {
    if (!(await isAdmin(ctx, startService))) return;
    await showMaterialSubmissions(ctx, repository);
  });

  bot.hears(/^Удаление данных(?: \(\d+\))?$/, async (ctx) => {
    if (!(await isAdmin(ctx, startService))) return;
    const sender = ctx.from;
    if (sender) await service.cancel(String(sender.id));
    await showDataDeletionRequests(ctx, repository);
  });

  bot.hears('Рефералы', async (ctx) => {
    if (!(await isAdmin(ctx, startService))) return;
    await ctx.reply('Реферальная программа:', {
      reply_markup: new InlineKeyboard()
        .text('Статистика рефералов', 'admin:referrals:stats')
        .text('Настроить бонусы', 'admin:referrals:bonus').row()
        .text('Назад', 'admin:menu:back'),
    });
  });

  bot.callbackQuery('admin:referrals:stats', async (ctx) => {
    if (!(await isAdmin(ctx, startService))) return;
    await showReferrals(ctx, repository);
  });

  bot.callbackQuery('admin:referrals:bonus', async (ctx) => {
    if (!(await isAdmin(ctx, startService))) return;
    const sender = ctx.from;
    if (!sender) return;
    await ctx.reply(await service.startReferralBonusSettings(String(sender.id)), { reply_markup: adminFlowKeyboard });
  });

  bot.callbackQuery('admin:menu:back', async (ctx) => {
    if (!(await isAdmin(ctx, startService))) return;
    await showAdminMenu(ctx, repository);
  });

  bot.hears('Статистика', async (ctx) => {
    if (!(await isAdmin(ctx, startService))) return;
    await ctx.reply('Статистика:', {
      reply_markup: new InlineKeyboard()
        .text('Общая статистика', 'admin:stats:general')
        .text('Рефералы и источники', 'admin:stats:referrals').row()
        .text('Назад', 'admin:menu:back'),
    });
  });

  bot.callbackQuery('admin:stats:general', async (ctx) => {
    if (!(await isAdmin(ctx, startService))) return;
    await showStatistics(ctx, repository);
  });

  bot.callbackQuery('admin:stats:referrals', async (ctx) => {
    if (!(await isAdmin(ctx, startService))) return;
    await showReferrals(ctx, repository);
  });

  bot.hears('Отменить', async (ctx, next) => {
    if (!(await isAdmin(ctx, startService))) return next();
    const sender = ctx.from;
    if (!sender || (await repository.getFlow(String(sender.id)))?.flowType !== 'promotional_broadcast') return next();
    await openBroadcastPlans(ctx);
  });

  bot.hears('Назад', async (ctx, next) => {
    if (!(await isAdmin(ctx, startService))) return next();
    const sender = ctx.from;
    if (!sender) return;
    if ((await repository.getFlow(String(sender.id)))?.flowType === 'promotional_broadcast') {
      await openBroadcastPlans(ctx);
      return;
    }
    const result = await service.goBack(String(sender.id));
    if (result.kind === 'prompt') {
      await ctx.reply(result.text, { reply_markup: adminFlowKeyboard });
    } else {
      await showAdminMenu(ctx, repository);
    }
  });

  bot.hears('В меню', async (ctx, next) => {
    if (!(await isAdmin(ctx, startService))) return next();
    const sender = ctx.from;
    if (sender && (await repository.getFlow(String(sender.id)))?.flowType === 'promotional_broadcast') {
      await openBroadcastPlans(ctx);
      return;
    }
    if (sender) await service.cancel(String(sender.id));
    await showAdminMenu(ctx, repository);
  });

  bot.command('cancel', async (ctx, next) => {
    if (!(await isAdmin(ctx, startService))) return next();
    const sender = ctx.from;
    if (sender && (await repository.getFlow(String(sender.id)))?.flowType === 'promotional_broadcast') {
      await openBroadcastPlans(ctx);
      return;
    }
    if (sender) await service.cancel(String(sender.id));
    await showAdminMenu(ctx, repository);
  });

  bot.on(['message:photo', 'message:video'], async (ctx, next) => {
    const sender = ctx.from;
    if (!sender || !(await isAdmin(ctx, startService))) return next();
    const adminId = String(sender.id);
    const flow = await repository.getFlow(adminId);
    if (flow?.flowType !== 'promotional_broadcast' || flow.step === 2) return next();

    let media: { type: 'photo' | 'video'; fileId: string }[];
    let caption = ctx.message.caption?.trim() ?? '';
    if (ctx.message.photo) {
      media = JSON.parse(flow.payload.media ?? '[]') as typeof media;
      const fileId = ctx.message.photo.at(-1)?.file_id;
      if (fileId) media.push({ type: 'photo', fileId });
    } else if (ctx.message.video) {
      media = JSON.parse(flow.payload.media ?? '[]') as typeof media;
      media.push({ type: 'video', fileId: ctx.message.video.file_id });
    } else {
      return next();
    }

    if (media.length > 10) {
      media.pop();
      await ctx.reply('В рассылку можно добавить не более 10 фото и видео.');
      return;
    }
    const text = flow.payload.text?.trim() || caption;
    if (text.length > 4096) {
      await ctx.reply('Подпись к медиа слишком длинная. Ограничение текста рассылки — 4096 символов.');
      return;
    }
    await repository.savePromotionalDraftFlow(adminId, {
      ...flow,
      step: (flow.step === 0 || (flow.step === 4 && flow.payload.scheduledBroadcastId)) && text ? 1 : flow.step,
      payload: { ...flow.payload, media: JSON.stringify(media), ...(text ? { text } : {}) },
    });
    const needsScheduleDate = flow.payload.mode === 'schedule' && !flow.payload.scheduleAt;
    const nextStepButton = needsScheduleDate ? 'Выбрать дату и время' : 'К предпросмотру';
    await ctx.reply(`${text ? 'Медиа добавлено' : 'Медиа принято'} (${media.length}/10).`, {
      reply_markup: new InlineKeyboard().text(nextStepButton, `admin:broadcast:${needsScheduleDate ? 'schedule' : 'preview'}:${flow.payload.draftToken ?? ''}`),
    });
  });

  bot.on('message:text', async (ctx, next) => {
    const sender = ctx.from;
    if (!sender || !(await isAdmin(ctx, startService))) {
      await next();
      return;
    }
    if (ctx.message.entities?.some((entity) => entity.type === 'bot_command')) {
      await ctx.reply('Неизвестная команда. Используйте доступные кнопки или отправьте /cancel, чтобы закрыть сценарий.');
      return;
    }

    const adminId = String(sender.id);
    if (ctx.message.text === 'В меню') {
      if ((await repository.getFlow(adminId))?.flowType === 'promotional_broadcast') {
        await openBroadcastPlans(ctx);
        return;
      }
      await service.cancel(adminId);
      await showAdminMenu(ctx, repository);
      return;
    }
    if (ctx.message.text === 'Назад') {
      if ((await repository.getFlow(adminId))?.flowType === 'promotional_broadcast') {
        await openBroadcastPlans(ctx);
        return;
      }
      const result = await service.goBack(adminId);
      if (result.kind === 'prompt') {
        await ctx.reply(result.text, { reply_markup: adminFlowKeyboard });
      } else {
        await showAdminMenu(ctx, repository);
      }
      return;
    }

    const flowBeforeAnswer = await repository.getFlow(adminId);
    if (flowBeforeAnswer?.flowType === 'promotional_broadcast' && flowBeforeAnswer.step === 5) {
      await ctx.reply('Выберите дату в календаре.');
      return;
    }
    if (flowBeforeAnswer?.flowType === 'promotional_broadcast' && flowBeforeAnswer.step === 6) {
      const time = ctx.message.text.trim();
      if (!isValidBroadcastTime(time)) {
        await ctx.reply(`Неверный формат. Введите ЧЧ:ММ (${BROADCAST_TIME_ZONE}).`);
        return;
      }
      const scheduledAt = broadcastLocalDateTimeToUtc(flowBeforeAnswer.payload.scheduleDate ?? '', time);
      if (!scheduledAt || scheduledAt.getTime() <= Date.now()) {
        await ctx.reply(`Это время прошло или недоступно. Введите будущее время (${BROADCAST_TIME_ZONE}).`);
        return;
      }
      const payload: Record<string, string> = {
        ...flowBeforeAnswer.payload,
        scheduleTime: time,
        scheduleAt: scheduledAt.toISOString(),
      };
      delete payload.originalScheduleAt;
      await repository.savePromotionalDraftFlow(adminId, {
        ...flowBeforeAnswer,
        step: 7,
        payload,
      });
      await showPromotionalBroadcastPreview(ctx, repository, adminId, flowBeforeAnswer.payload.draftToken ?? '');
      return;
    }
    const result = await service.answer(adminId, ctx.message.text);
    if (!result) return;
    if (flowBeforeAnswer?.flowType === 'promotional_broadcast'
      && flowBeforeAnswer.step === 3
      && result.kind === 'prompt') {
      await showPromotionalBroadcastPreview(ctx, repository, adminId, flowBeforeAnswer.payload.draftToken ?? '');
      return;
    }
    if (result.kind === 'prompt' || result.kind === 'invalid') {
      const activeFlow = await repository.getFlow(adminId);
      await ctx.reply(result.text, {
        reply_markup: activeFlow?.flowType === 'promotional_broadcast'
          ? new InlineKeyboard().text(
            activeFlow.payload.mode === 'schedule' && !activeFlow.payload.scheduleAt ? 'Выбрать дату и время' : 'К предпросмотру',
            `admin:broadcast:${activeFlow.payload.mode === 'schedule' && !activeFlow.payload.scheduleAt ? 'schedule' : 'preview'}:${activeFlow.payload.draftToken ?? ''}`,
          )
          : adminFlowKeyboard,
      });
    } else if (result.kind === 'done') {
      if (result.customerNotification) {
        await Promise.allSettled([
          ctx.api.sendMessage(
            result.customerNotification.telegramId,
            fromAdmin(`Для заказа №${result.customerNotification.orderNumber} назначена дата публикации: ${displayPublicationDate(result.customerNotification.publicationAt)}. Статус и детали доступны в разделе «Текущие заказы».`),
          ),
        ]);
      }
      if (result.publicationNotification) {
        const publication = result.publicationNotification;
        await Promise.allSettled([
          ctx.api.sendMessage(
            publication.telegramId,
            fromAdmin(publicationNotificationText(publication)),
          ),
        ]);
      }
      await ctx.reply(result.text, { reply_markup: adminMenuKeyboard() });
    } else if (result.kind === 'businesses') {
      if (result.rows.length === 0) await ctx.reply('По этому запросу заявок нет.');
      else {
        for (const lead of result.rows) {
          await ctx.reply(leadText(lead), {
            reply_markup: new InlineKeyboard().text('Написать рекламодателю', `admin:message_lead:${lead.telegramId}`),
          });
        }
      }
    } else if (result.kind === 'send_message') {
      try {
        let sentAsMaterialRevision = false;
        let isDataDeletionRequest = false;
        if (result.materialOrderId) {
          const reopened = await repository.requestMaterialCorrections(
            result.materialOrderId,
            result.message,
          );
          if (reopened) {
            const state = await materialService.current(result.telegramId);
            if (state) {
              await sendMaterialPromptTo(ctx.api, result.telegramId, state);
              sentAsMaterialRevision = true;
            }
          }
        }
        if (!sentAsMaterialRevision) {
          const paymentReplyKeyboard = result.paymentRequestId && result.paymentOrderId
            ? new InlineKeyboard()
              .text('Ответить администратору', `order:alternative:${result.paymentOrderId}`).row()
            : undefined;
          if (paymentReplyKeyboard && result.paymentMode === 'instructions') {
            paymentReplyKeyboard.text('Сообщить об оплате', `order:custom_paid:${result.paymentOrderId}`);
          }
          await ctx.api.sendMessage(result.telegramId, fromAdmin(`${result.customerContext}\n\n${result.message}`),
            paymentReplyKeyboard ? { reply_markup: paymentReplyKeyboard } : {},
          );
          if (result.paymentRequestId) await repository.markPaymentMethodRequestAnswered(result.paymentRequestId);
        }
        if (result.inquiryId) {
          const inquiry = await repository.getInquiry(result.inquiryId);
          isDataDeletionRequest = Boolean(inquiry && isDataDeletionInquiry(inquiry.topic));
          if (!isDataDeletionRequest) await repository.deleteInquiry(result.inquiryId);
        }
        try {
          await service.recordMessage(adminId, result.telegramId, result.message);
        } catch (error) {
          console.error('Could not record the admin message after it was delivered:', error);
        }
        await ctx.reply(result.inquiryId
          ? isDataDeletionRequest
            ? 'Ответ отправлен. Запрос остаётся в списке; нажмите «Удалить данные», чтобы удалить данные пользователя из базы.'
            : 'Ответ отправлен, вопрос удалён из списка.'
          : 'Сообщение отправлено рекламодателю.', {
          reply_markup: adminMenuKeyboard(),
        });
      } catch {
        await ctx.reply('Не удалось отправить сообщение. Проверьте, что пользователь доступен в Telegram.', {
          reply_markup: adminMenuKeyboard(),
        });
      }
    }
  });
}
