import { Bot, InlineKeyboard, type Context } from 'grammy';
import type { AdvertiserRepository } from '../../../db/repositories/advertiser-repository.ts';
import type { AdminRepository } from '../../../db/repositories/admin-repository.ts';
import { AdvertiserService } from '../../../services/advertiser-service.ts';
import { OrderService } from '../../../services/order-service.ts';
import type { StartService } from '../../../services/start-service.ts';
import type { OrderMaterialService } from '../../../services/order-material-service.ts';
import { currentIsoDate, monthKey } from '../../keyboards/calendar.ts';
import { menuKeyboard, isAdvertiser, askPlacementDate, showOrderSummary, showUserOrders, sendMaterialPrompt, handleMaterialAnswer, showTariffs, showOrderTariffs, backButton, sendInquiryToAdmins } from './presentation.ts';

export function registerConversationHandlers(bot: Bot, advertisers: AdvertiserRepository, service: AdvertiserService, startService: StartService, orderService: OrderService, materialService: OrderMaterialService, adminRepository: AdminRepository): void {
  const cancelAdvertiserFlow = async (ctx: Context): Promise<void> => {
    const sender = ctx.from;
    if (!sender) return;
    const telegramId = String(sender.id);
    const pausedMaterial = await materialService.pause(telegramId);
    if (pausedMaterial) {
      await ctx.reply('Передача материалов приостановлена. Ваши ответы сохранены; продолжить можно в разделе «Текущие заказы».', {
        reply_markup: await menuKeyboard(ctx, startService),
      });
      return;
    }
    const paymentProof = await orderService.pendingPaymentProof(telegramId);
    if (paymentProof) {
      await orderService.cancelPaymentProof(paymentProof.orderId, telegramId);
      await ctx.reply(`Отправка скриншота для заказа №${paymentProof.orderNumber} отменена. Если понадобится, начните её снова из раздела «Текущие заказы».`, {
        reply_markup: await menuKeyboard(ctx, startService),
      });
      return;
    }
    const alternativePayment = await orderService.pendingAlternativePaymentRequest(telegramId);
    if (alternativePayment) {
      await orderService.cancelAlternativePaymentRequest(telegramId);
      await ctx.reply(`Запрос другого способа оплаты по заказу №${alternativePayment.orderNumber} отменён.`, {
        reply_markup: await menuKeyboard(ctx, startService),
      });
      return;
    }
    await service.cancel(telegramId);
    await orderService.cancel(telegramId);
    await ctx.reply('Текущий диалог отменён. Выберите раздел в меню.', {
      reply_markup: await menuKeyboard(ctx, startService),
    });
  };

  bot.command('cancel', async (ctx) => {
    if (!(await isAdvertiser(ctx, startService))) return;
    await cancelAdvertiserFlow(ctx);
  });

  bot.on('message:text', async (ctx, next) => {
    const sender = ctx.from;
    if (!sender) return;
    if (!(await isAdvertiser(ctx, startService))) return;
    // Accept a visually identical command typed with Cyrillic "с" as well.
    if (/^\/can[cс]el(?:@\w+)?$/iu.test(ctx.message.text)) {
      await cancelAdvertiserFlow(ctx);
      return;
    }
    if (ctx.message.entities?.some((entity) => entity.type === 'bot_command')) {
      await ctx.reply('Неизвестная команда. Чтобы приостановить текущий диалог, отправьте /cancel.');
      return;
    }

    const paymentProof = await orderService.pendingPaymentProof(String(sender.id));
    if (paymentProof) {
      await ctx.reply(`Ожидаю скриншот или фото чека по заказу №${paymentProof.orderNumber}. Чтобы отказаться от отправки, нажмите /cancel.`);
      return;
    }

    const alternativePaymentInput = await orderService.pendingAlternativePaymentRequest(String(sender.id));
    if (alternativePaymentInput) {
      const request = await orderService.submitAlternativePaymentRequest(String(sender.id), ctx.message.text.trim());
      if (!request) {
        await ctx.reply('Не удалось сохранить запрос. Попробуйте выбрать другой способ оплаты ещё раз.');
        return;
      }
      const label = `${request.businessName} · ${request.firstName}${request.username ? ` (@${request.username})` : ''}`;
      const sent = await Promise.allSettled(request.adminTelegramIds.map((adminId) => ctx.api.sendMessage(
        adminId,
        `${request.requestKind === 'problem' ? 'Сообщение о проблеме с оплатой' : 'Запрос другого способа оплаты'}\nЗаказ №${request.orderNumber} · ${request.amount} ${request.currency.trim()}\nПокупатель: ${label}\nЗапрос: ${request.message}\n\nВыберите, как ответить:`,
        { reply_markup: new InlineKeyboard()
          .text('Ответить сообщением', `admin:payreq:r:${request.requestId}`).row()
          .text('Отправить реквизиты и кнопку оплаты', `admin:payreq:i:${request.requestId}`) },
      )));
      await ctx.reply(sent.some((item) => item.status === 'fulfilled')
        ? `Запрос по заказу №${request.orderNumber} отправлен администратору.`
        : 'Запрос сохранён, но отправить уведомление администратору не удалось. Попробуйте позже.');
      return;
    }

    const materialFlow = await materialService.current(String(sender.id));
    if (materialFlow) {
      const repliedToAdminNotification = ctx.message.reply_to_message?.from?.is_bot
        && ctx.message.reply_to_message.text?.startsWith('✉️ Сообщение от администратора:');
      if (repliedToAdminNotification) {
        await ctx.reply('Это уведомление от администратора не меняет передачу материалов. Ваши ответы сохранены. Продолжить можно в разделе «Текущие заказы» кнопкой «Продолжить передачу материалов».');
        return;
      }
      if (materialFlow.revisionMode && ctx.message.text === 'Назад') {
        const state = await materialService.revisionMenu(String(sender.id));
        if (state) await sendMaterialPrompt(ctx, state);
        return;
      }
      if (['Посмотреть тарифы', 'Оформить рекламу', 'Реферальная программа', 'Задать вопрос'].includes(ctx.message.text)) {
        await ctx.reply('Сначала завершите передачу материалов или приостановите её командой /cancel. Текущие ответы сохранены.', {
          reply_markup: await menuKeyboard(ctx, startService),
        });
        return;
      }
      if (ctx.message.text === 'В меню') {
        await ctx.reply('Передача материалов не завершена. Ваши ответы сохранены; продолжить можно в разделе «Текущие заказы».', {
          reply_markup: await menuKeyboard(ctx, startService),
        });
        return;
      }
      if (ctx.message.text === 'Мои заказы' || ctx.message.text === 'Мои заявки') {
        await ctx.reply('Выберите раздел:', {
          reply_markup: new InlineKeyboard()
            .text('Текущие заказы', 'user:orders:active')
            .text('История заказов', 'user:orders:history').row()
            .text('Назад', 'user:orders:back'),
        });
        return;
      }
      if (ctx.message.text === 'История заказов') {
        await showUserOrders(ctx, orderService, 'history');
        return;
      }
      if (ctx.message.text === 'Текущие заказы') {
        await showUserOrders(ctx, orderService, 'active');
        return;
      }
      await handleMaterialAnswer(ctx, await materialService.answerText(String(sender.id), ctx.message.text), startService, adminRepository);
      return;
    }

    if (await adminRepository.hasFeedbackInput(String(sender.id))) {
      if (['Посмотреть тарифы', 'Мои заказы', 'Мои заявки', 'Настройки', 'Реферальная программа', 'Задать вопрос', 'Оформить рекламу'].includes(ctx.message.text)) {
        await adminRepository.cancelFeedbackInput(String(sender.id));
        await next();
        return;
      }
      const text = ctx.message.text.trim();
      if (!text) {
        await ctx.reply('Напишите отзыв или сообщение текстом.');
        return;
      }
      if (text.length > 3000) {
        await ctx.reply('Сообщение слишком длинное. Ограничение — 3000 символов; отправьте его короче.');
        return;
      }
      const saved = await adminRepository.completeFeedbackInput(String(sender.id), text);
      if (!saved) {
        await ctx.reply('Не удалось сохранить сообщение. Откройте отзыв в завершённом заказе и попробуйте снова.');
        return;
      }
      if (saved.senderType === 'user') {
        const notice = saved.reviewSaved
          ? `${saved.response === 'discuss' ? '💬 Отзыв к обсуждению' : saved.response === 'repeat' ? '🔁 Отзыв о повторном размещении' : '⭐ Положительный отзыв'} по заказу №${saved.orderNumber}\nБизнес: ${saved.businessName}\nТариф: ${saved.tariffName}\nПользователь: ${saved.userName}\n\nОтзыв: ${text}`
          : `💬 Сообщение по обсуждению итога заказа №${saved.orderNumber}\nБизнес: ${saved.businessName}\nТариф: ${saved.tariffName}\nПользователь: ${saved.userName}\n\n${text}`;
        await Promise.allSettled(saved.adminTelegramIds.map((adminId) => ctx.api.sendMessage(adminId, notice, {
          reply_markup: new InlineKeyboard().text('Открыть отзыв', `admin:feedback:open:${saved.orderId}`),
        })));
        if (saved.reviewSaved) {
          await ctx.reply('Спасибо! Ваш отзыв сохранён. Хотите повторить заказ? После подтверждения и оплаты можно будет использовать прошлые материалы или отправить новые.', {
            reply_markup: new InlineKeyboard()
              .text('Повторить заказ', `feedback:repeat_order:${saved.orderId}`).row()
              .text('Не сейчас', `feedback:later:${saved.orderId}`),
          });
        } else {
          await ctx.reply('Сообщение отправлено администратору в обсуждение отзыва.');
        }
      } else {
        await ctx.api.sendMessage(
          saved.userTelegramId,
          `✉️ Ответ администратора по обсуждению итога заказа №${saved.orderNumber}\n\n${text}`,
          { reply_markup: new InlineKeyboard().text('Ответить по отзыву', `feedback:reply:${saved.orderId}`) },
        );
        await ctx.reply(`Ответ по отзыву заказа №${saved.orderNumber} отправлен пользователю.`);
      }
      return;
    }

    if (ctx.message.text === 'В меню') {
      await adminRepository.cancelFeedbackInput(String(sender.id));
      await service.cancel(String(sender.id));
      await orderService.cancel(String(sender.id));
      await ctx.reply('Текущий диалог закрыт. Выберите раздел в меню.', {
        reply_markup: await menuKeyboard(ctx, startService),
      });
      return;
    }

    if (ctx.message.text === 'Назад') {
      await adminRepository.cancelFeedbackInput(String(sender.id));
      const hasOrderDraft = await orderService.cancel(String(sender.id));
      if (hasOrderDraft) {
        await showTariffs(ctx, advertisers, startService);
        return;
      }
      const previous = await service.goBack(String(sender.id));
      await ctx.reply(
        previous.kind === 'prompt' ? previous.text : 'Вы вернулись в меню. Выберите раздел.',
        { reply_markup: previous.kind === 'prompt' ? backButton() : await menuKeyboard(ctx, startService) },
      );
      return;
    }

    const draftBeforeAnswer = await orderService.summary(String(sender.id));
    const menuActions = new Set([
      'Посмотреть тарифы', 'Мои заказы', 'Мои заявки', 'Настройки',
      'Реферальная программа', 'Задать вопрос', 'Оформить рекламу',
    ]);
    if (draftBeforeAnswer?.status === 'awaiting_date' && menuActions.has(ctx.message.text)) {
      await next();
      return;
    }

    const answer = await service.answer(String(sender.id), ctx.message.text);
    if (!answer) {
      const draft = await orderService.summary(String(sender.id));
      if (!draft || draft.status !== 'awaiting_date') {
        await next();
        return;
      }
      if (draft.publicationCount > 1) {
        await ctx.reply('Для тарифа с несколькими публикациями выберите дату каждой публикации в календаре выше.');
        return;
      }
      const result = await orderService.setDate(String(sender.id), ctx.message.text);
      if (result.kind === 'saved') {
        await showOrderSummary(ctx, result.summary);
      } else if (result.kind === 'invalid') {
        const [year, month] = currentIsoDate().split('-').map(Number);
        await ctx.reply('Не удалось распознать дату. Укажите будущую дату в формате ДД.ММ.ГГГГ или ГГГГ-ММ-ДД.', {
          reply_markup: new InlineKeyboard()
            .text('Выбрать дату', `order:calendar:${monthKey(year, month)}`).row()
            .text('Назад', 'order:back'),
        });
      } else {
        await ctx.reply('Черновик заказа не найден. Начните оформление заново.');
      }
      return;
    }

    switch (answer.kind) {
      case 'prompt':
        await ctx.reply(answer.text, { reply_markup: backButton() });
        break;
      case 'empty':
        await ctx.reply('Отправьте ответ текстом или нажмите «Назад».', { reply_markup: backButton() });
        break;
      case 'cancelled':
        await ctx.reply('Текущий диалог отменён. Выберите раздел в меню.', {
          reply_markup: await menuKeyboard(ctx, startService),
        });
        break;
      case 'onboarding_complete':
        await ctx.reply(answer.alreadySaved
          ? answer.pendingTariffId
            ? 'Данные о вашем бизнесе уже сохранены. Открываю выбранный тариф для подтверждения заказа.'
            : 'Данные о вашем бизнесе уже сохранены. Повторно запрашивать их не нужно.'
          : answer.pendingTariffId
            ? 'Спасибо! Информация о проекте сохранена. Открываю выбранный тариф для подтверждения заказа.'
            : 'Спасибо! Информация о вашем проекте сохранена. Теперь можно выбрать тариф.', {
          reply_markup: await menuKeyboard(ctx, startService),
        });
        if (answer.pendingTariffId) {
          const telegramId = String(sender.id);
          if (await orderService.begin(telegramId, answer.pendingTariffId)) {
            const draft = await orderService.summary(telegramId);
            if (draft?.status === 'ready') await showOrderSummary(ctx, draft);
            else if (draft) await askPlacementDate(ctx, draft);
            else {
              await ctx.reply('Анкета сохранена, но не удалось открыть выбранный тариф. Выберите его в каталоге.');
              await showOrderTariffs(ctx, advertisers, startService);
            }
          } else {
            await ctx.reply('Анкета сохранена, но выбранный тариф уже недоступен. Выберите актуальный тариф.');
            await showOrderTariffs(ctx, advertisers, startService);
          }
        } else if (!answer.alreadySaved) await showOrderTariffs(ctx, advertisers, startService);
        break;
      case 'question_submitted': {
        const delivered = await sendInquiryToAdmins(
          ctx,
          answer.inquiry,
          adminRepository,
        );
        const response = delivered
          ? 'Спасибо! Вопрос передан администратору.'
          : answer.inquiry.adminTelegramIds.length === 0
            ? 'Спасибо! Вопрос сохранён, но администраторы ещё не настроены.'
            : 'Спасибо! Вопрос сохранён, но не удалось доставить его администраторам.';
        await ctx.reply(response, { reply_markup: await menuKeyboard(ctx, startService) });
        break;
      }
      case 'contact_updated':
        await ctx.reply(answer.saved
          ? 'Контактные данные обновлены.'
          : 'Не удалось найти сохранённый профиль бизнеса. Сначала заполните анкету рекламодателя.', {
          reply_markup: await menuKeyboard(ctx, startService),
        });
        break;
    }
  });
}
