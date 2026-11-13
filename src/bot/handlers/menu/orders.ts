import { Bot, InlineKeyboard } from 'grammy';
import type { AdvertiserRepository } from '../../../db/repositories/advertiser-repository.ts';
import type { AdminRepository } from '../../../db/repositories/admin-repository.ts';
import { AdvertiserService } from '../../../services/advertiser-service.ts';
import { OrderService } from '../../../services/order-service.ts';
import type { StartService } from '../../../services/start-service.ts';
import { config } from '../../../config/env.ts';
import { calendarKeyboard, currentIsoDate, parseCalendarMonth } from '../../keyboards/calendar.ts';
import { notifyNewOrder, notifyPaymentReported } from '../../../services/admin-notifications.ts';
import { paymentMethodsKeyboard } from '../../keyboards/payment.ts';
import { menuKeyboard, isAdvertiser, askPlacementDate, showOrderSummary, showUserOrders, clearUserOrderListMessages, beginOnboarding, showTariffs, showOrderTariffs, calendarPrompt, dateEntryKeyboard, dateEntryText, dateSelectionKeyboard, dateSelectionText, repeatIntervalKeyboard, repeatWeekdayKeyboard, tariffCatalogText, tariffCatalogKeyboard, publicationDateEditorText, publicationDateEditorKeyboard, publicationDateOverviewText, publicationDateOverviewKeyboard, orderSummaryText, orderSummaryKeyboard } from './presentation.ts';
import { customerLabel } from '../../../services/admin-display.ts';
import { displayIsoDate } from '../../../services/publication-dates.ts';

function requiresTransferScreenshot(method: { id: string; title: string }): boolean {
  return method.id === 'ru_card' || method.id === 'fr_bank';
}

function weekdayPhrase(weekday: number): string {
  return ['', 'каждый понедельник', 'каждый вторник', 'каждую среду', 'каждый четверг', 'каждую пятницу', 'каждую субботу', 'каждое воскресенье'][weekday] ?? '';
}

function nextWeekdayIsoDate(fromDate: string, weekday: number): string {
  const date = new Date(`${fromDate}T00:00:00.000Z`);
  const currentWeekday = (date.getUTCDay() + 6) % 7 + 1;
  const daysUntil = (weekday - currentWeekday + 7) % 7;
  date.setUTCDate(date.getUTCDate() + daysUntil);
  return date.toISOString().slice(0, 10);
}

function feedbackRatingKeyboard(orderId: string): InlineKeyboard {
  return new InlineKeyboard()
    .text('Все понравилось', `feedback:good:${orderId}`).row()
    .text('Хочу обсудить итог', `feedback:discuss:${orderId}`).row()
    .text('Хочу повторить рекламу', `feedback:repeat:${orderId}`);
}

function feedbackNextStepsKeyboard(orderId: string, includeTariffs = false): InlineKeyboard {
  const keyboard = new InlineKeyboard()
    .text('Оставить отзыв', `feedback:review:${orderId}`).row()
    .text('Написать администратору', `feedback:message:${orderId}`).row()
    .text('Повторить заказ', `feedback:repeat_order:${orderId}`);
  if (includeTariffs) keyboard.row().text('Посмотреть тарифы', 'order:catalog');
  return keyboard;
}

export function registerOrderHandlers(bot: Bot, advertisers: AdvertiserRepository, service: AdvertiserService, startService: StartService, orderService: OrderService, adminRepository: AdminRepository): void {
  bot.callbackQuery(/^feedback:/, async (ctx) => {
    const sender = ctx.from;
    if (!sender || !(await isAdvertiser(ctx, startService))) return;
    const [, rawAction, rawOrderId] = ctx.callbackQuery.data.split(':');
    const legacyResponse = ['good', 'discuss', 'repeat'].includes(rawOrderId ?? '')
      ? rawOrderId
      : undefined;
    const action = legacyResponse ?? rawAction;
    const orderId = legacyResponse ? rawAction : rawOrderId;
    if (!orderId) return;
    if (action === 'repeat_order') {
      const order = (await orderService.orderHistory(String(sender.id))).find((item) => item.id === orderId);
      if (!order || order.status !== 'completed') {
        await ctx.answerCallbackQuery({ text: 'Завершённый заказ не найден.' });
        return;
      }
      if (!(await orderService.begin(String(sender.id), order.tariffId))) {
        await ctx.answerCallbackQuery({ text: 'Этот тариф уже недоступен. Выберите актуальный тариф.' });
        await ctx.editMessageText('Тариф из прошлого заказа больше недоступен. Выберите актуальный тариф:', {
          reply_markup: new InlineKeyboard().text('Посмотреть тарифы', 'order:catalog'),
        });
        return;
      }
      const draft = await orderService.setAwaitingDate(String(sender.id));
      await ctx.editMessageText('Оформляем повторный заказ. Выберите дату размещения:', {
        reply_markup: draft ? dateSelectionKeyboard(draft) : undefined,
      });
      return;
    }
    if (action === 'later') {
      await ctx.editMessageText('Хорошо! Если захотите повторить заказ, откройте его в истории заказов.');
      return;
    }
    if (action === 'review' || action === 'message' || action === 'reply') {
      const mode = action === 'review' ? 'review' : 'message';
      const started = await adminRepository.startFeedbackInput(String(sender.id), orderId, 'user', mode);
      if (!started) {
        await ctx.answerCallbackQuery({ text: mode === 'review' ? 'Отзыв уже оставлен или заказ не найден.' : 'Обсуждение не найдено.' });
        return;
      }
      const prompt = action === 'reply'
        ? 'Напишите ответ администратору по обсуждению итога размещения.'
        : mode === 'review'
          ? 'Напишите отзыв об итогах размещения одним сообщением.'
          : 'Напишите сообщение администратору по итогам размещения. Оно попадёт в отдельное обсуждение отзыва.';
      if (action === 'reply') await ctx.reply(prompt);
      else await ctx.editMessageText(prompt);
      return;
    }

    if (action !== 'good' && action !== 'discuss' && action !== 'repeat') return;
    const response = action;
    const result = await orderService.recordFeedback(orderId, String(sender.id), response);
    if (!result) {
      await ctx.editMessageText('Ответ по этому размещению уже получен или заказ не найден.');
      return;
    }

    const outcome = response === 'discuss' ? '💬 Хочет обсудить итог' : response === 'good' ? '👍 Положительный отзыв' : '🔁 Хочет повторить рекламу';
    const label = customerLabel(result.firstName, result.username, result.businessName);
    await Promise.allSettled(result.adminTelegramIds.map((adminId) => ctx.api.sendMessage(
      adminId,
      `${outcome}\nЗаказ №${result.orderNumber} · тариф «${result.tariffName}» · бизнес «${result.businessName}».\nПользователь: ${label}`,
      { reply_markup: new InlineKeyboard().text('Открыть отзыв', `admin:feedback:open:${orderId}`) },
    )));

    const text = response === 'discuss'
      ? 'Спасибо, отметили, что вы хотите обсудить итог. Хотите оставить отзыв или написать администратору?'
      : response === 'good'
        ? 'Спасибо! Рады, что всё понравилось. Хотите оставить отзыв или написать администратору?'
        : 'Спасибо! Хотите оставить отзыв или написать администратору?';
    await ctx.editMessageText(text, { reply_markup: feedbackNextStepsKeyboard(orderId, response === 'repeat') });
  });

  bot.callbackQuery(/^od[cx]:/, async (ctx) => {
    const sender = ctx.from;
    if (!sender || !(await isAdvertiser(ctx, startService))) return;
    const [action, orderId, rawIndex, expectedDate] = ctx.callbackQuery.data.split(':');
    const publicationIndex = Number(rawIndex);
    if (!orderId || !expectedDate || !/^\d{4}-\d{2}-\d{2}$/.test(expectedDate)
      || !Number.isInteger(publicationIndex) || publicationIndex < 0) return;

    if (action === 'odc') {
      const confirmed = await orderService.confirmPublicationDate(String(sender.id), orderId, publicationIndex, expectedDate);
      if (!confirmed) {
        await ctx.answerCallbackQuery({ text: 'Предложение уже обработано или устарело.' });
        return;
      }
      await Promise.allSettled(confirmed.adminTelegramIds.map((adminId) => ctx.api.sendMessage(
        adminId,
        `✅ Пользователь согласовал дату публикации ${confirmed.publicationNumber} заказа №${confirmed.orderNumber}: ${displayIsoDate(confirmed.date)}. Публикацию можно отметить после выхода.`,
        { reply_markup: new InlineKeyboard().text('Открыть публикации заказа', `admin:order:completed:${orderId}`) },
      )));
      await ctx.editMessageText('Дата согласована. Администратор сможет отметить публикацию после её выхода.', {
        reply_markup: new InlineKeyboard(),
      });
      await ctx.answerCallbackQuery({ text: 'Дата согласована.' });
      return;
    }

    if (action === 'odx') {
      const request = await orderService.requestPublicationDateChange(String(sender.id), orderId, publicationIndex, expectedDate);
      if (!request) {
        await ctx.answerCallbackQuery({ text: 'Предложение уже обработано или устарело.' });
        return;
      }
      await Promise.allSettled(request.adminTelegramIds.map((adminId) => ctx.api.sendMessage(
        adminId,
        `📅 Пользователь просит изменить предложенную дату публикации ${request.publicationNumber} заказа №${request.orderNumber}: ${displayIsoDate(request.date)}. Выберите новую дату.`,
        { reply_markup: new InlineKeyboard().text('Назначить новую дату', `admin:md:edit:${orderId}:${publicationIndex}`) },
      )));
      await ctx.editMessageText('Запрос на изменение даты отправлен администратору. Он предложит новую дату для согласования.', {
        reply_markup: new InlineKeyboard(),
      });
      await ctx.answerCallbackQuery({ text: 'Запрос отправлен.' });
    }
  });

  bot.hears(['Мои заказы', 'Мои заявки'], async (ctx) => {
    if (!(await isAdvertiser(ctx, startService))) return;
    const sender = ctx.from;
    if (sender) {
      await adminRepository.cancelFeedbackInput(String(sender.id));
      await clearUserOrderListMessages(ctx, String(sender.id));
    }
    await ctx.reply('Выберите раздел:', {
      reply_markup: new InlineKeyboard()
        .text('Текущие заказы', 'user:orders:active')
        .text('История заказов', 'user:orders:history'),
    });
  });

  bot.hears('Текущие заказы', async (ctx) => {
    if (!(await isAdvertiser(ctx, startService))) return;
    await showUserOrders(ctx, orderService, 'active');
  });

  bot.hears('История заказов', async (ctx) => {
    if (!(await isAdvertiser(ctx, startService))) return;
    await showUserOrders(ctx, orderService, 'history');
  });

  bot.callbackQuery('user:orders:active', async (ctx) => {
    if (!(await isAdvertiser(ctx, startService))) return;
    await showUserOrders(ctx, orderService, 'active');
  });

  bot.callbackQuery('user:orders:history', async (ctx) => {
    if (!(await isAdvertiser(ctx, startService))) return;
    await showUserOrders(ctx, orderService, 'history');
  });

  bot.callbackQuery('user:orders:back', async (ctx) => {
    if (!(await isAdvertiser(ctx, startService))) return;
    await ctx.reply('Главное меню:', { reply_markup: await menuKeyboard(ctx, startService) });
  });

  bot.callbackQuery(/^order:/, async (ctx) => {
    const sender = ctx.from;
    if (!sender || !(await isAdvertiser(ctx, startService))) return;
    const telegramId = String(sender.id);
    const [scope, action, value] = ctx.callbackQuery.data.split(':');
    const methodId = ctx.callbackQuery.data.split(':')[3];

    if (scope !== 'order') return;
    if (action === 'feedback' && value === 'start') {
      const orderId = ctx.callbackQuery.data.split(':')[3];
      const order = (await orderService.orderHistory(telegramId)).find((item) => item.id === orderId);
      if (!order || order.status !== 'completed' || order.feedbackResponse) {
        await ctx.answerCallbackQuery({ text: 'Отзыв уже оставлен или заказ недоступен.' });
        return;
      }
      await ctx.editMessageText(`Как вам результат размещения по заказу №${order.orderNumber}?`, {
        reply_markup: feedbackRatingKeyboard(order.id),
      });
      return;
    }
    if (action === 'dates') {
      const summary = await orderService.summary(telegramId);
      if (!summary) return;
      const subAction = ctx.callbackQuery.data.split(':')[2];
      const parts = ctx.callbackQuery.data.split(':');
      if (subAction === 'choose') {
        await ctx.editMessageText(dateSelectionText(summary), { reply_markup: dateSelectionKeyboard(summary) });
        return;
      }
      if (subAction === 'entry') {
        await ctx.editMessageText(dateEntryText(summary), { reply_markup: dateEntryKeyboard() });
        return;
      }
      if (subAction === 'back') {
        await ctx.editMessageText(dateSelectionText(summary), { reply_markup: dateSelectionKeyboard(summary) });
        return;
      }
      if (subAction === 'manual') {
        if (summary.publicationCount > 1) {
          const editable = await orderService.preparePublicationDateEdit(telegramId);
          if (!editable) return;
          const index = Math.max(0, editable.publicationDates.findIndex((date) => !date));
          const [year, month] = currentIsoDate().split('-').map(Number);
          await ctx.editMessageText(publicationDateEditorText(editable, index), {
            reply_markup: publicationDateEditorKeyboard(editable, index, year, month, true),
          });
        } else {
          const [year, month] = currentIsoDate().split('-').map(Number);
          await ctx.editMessageText(calendarPrompt, { reply_markup: calendarKeyboard(year, month) });
        }
        return;
      }
      if (subAction === 'interval') {
        const unit = parts[3];
        if (unit !== 'days' && unit !== 'weeks') return;
        if (unit === 'weeks') {
          await ctx.editMessageText('Выберите день недели для публикаций:', {
            reply_markup: repeatWeekdayKeyboard(1),
          });
          return;
        }
        await ctx.editMessageText(unit === 'days' ? 'Как часто публиковать: выберите интервал в днях.' : 'Как часто публиковать: выберите интервал в неделях.', {
          reply_markup: repeatIntervalKeyboard(unit),
        });
        return;
      }
      if (subAction === 'repeat') {
        const unit = parts[3];
        const interval = Number(parts[4]);
        if ((unit !== 'days' && unit !== 'weeks') || !Number.isInteger(interval) || interval < 1 || interval > 12) return;
        if (unit === 'weeks') {
          await ctx.editMessageText('Выберите день недели для публикаций:', {
            reply_markup: repeatWeekdayKeyboard(1),
          });
          return;
        }
        const updated = await orderService.setRecurringPublicationDates(telegramId, currentIsoDate(), 'days', interval);
        if (updated?.status === 'ready') {
          await ctx.editMessageText(orderSummaryText(updated), { reply_markup: orderSummaryKeyboard(updated) });
        } else {
          await ctx.answerCallbackQuery({ text: 'Не удалось автоматически рассчитать даты.' });
        }
        return;
      }
      if (subAction === 'weekday') {
        const interval = Number(parts[3]);
        const weekday = Number(parts[4]);
        if (interval !== 1 || !Number.isInteger(weekday) || weekday < 1 || weekday > 7) return;
        const startDate = nextWeekdayIsoDate(currentIsoDate(), weekday);
        const updated = await orderService.setRecurringPublicationDates(telegramId, startDate, 'weeks', 1, weekday);
        if (updated?.status === 'ready') {
          await ctx.editMessageText(orderSummaryText(updated), { reply_markup: orderSummaryKeyboard(updated) });
        } else {
          await ctx.answerCallbackQuery({ text: 'Не удалось автоматически рассчитать даты.' });
        }
        return;
      }
    }
    if (action === 'repeat') {
      const parts = ctx.callbackQuery.data.split(':');
      const subAction = value;
      const token = subAction === 'calendar_back' ? parts[3] ?? '' : parts[4] ?? '';
      const match = /^(days|weeks)(\d{1,2})(?:d([1-7]))?$/.exec(token);
      if (match && (Number(match[2]) > 12 || (match[1] === 'days' && match[3]) || (match[1] === 'weeks' && !match[3]))) return;
      if (subAction === 'calendar' && parts[3]) {
        const month = parseCalendarMonth(parts[3]);
        if (!month || !match) return;
        const weekdayText = match[3]
          ? `Выберите первую дату публикации в календаре: только ${['', 'понедельник', 'вторник', 'среду', 'четверг', 'пятницу', 'субботу', 'воскресенье'][Number(match[3])]}; далее — ${weekdayPhrase(Number(match[3]))}.`
          : 'Выберите первую дату публикации в календаре.';
        await ctx.editMessageText(weekdayText, {
          reply_markup: calendarKeyboard(month.year, month.month, 'order:repeat', currentIsoDate(), token, match[3] ? Number(match[3]) : undefined),
        });
        return;
      }
      if (subAction === 'calendar_back' && match) {
        if (match[3]) {
          await ctx.editMessageText('Выберите день недели для публикаций:', {
            reply_markup: repeatWeekdayKeyboard(1),
          });
        } else {
          await ctx.editMessageText('Выберите интервал в днях.', {
            reply_markup: repeatIntervalKeyboard('days'),
          });
        }
        return;
      }
      if (subAction === 'noop') {
        await ctx.answerCallbackQuery();
        return;
      }
      if (subAction === 'pickdate' && match) {
        const updated = await orderService.setRecurringPublicationDates(
          telegramId,
          parts[3] ?? '',
          match[1] as 'days' | 'weeks',
          Number(match[2]),
          match[3] ? Number(match[3]) : undefined,
        );
        if (updated?.status === 'ready') {
          await ctx.editMessageText(orderSummaryText(updated), { reply_markup: orderSummaryKeyboard(updated) });
        } else {
          await ctx.answerCallbackQuery({ text: 'Не удалось рассчитать даты. Выберите будущую дату.' });
        }
        return;
      }
    }
    if ((action === 'alternative' || action === 'problem') && value) {
      await orderService.cancelPaymentCheckoutReminder(value, telegramId);
      const existingRequest = await orderService.pendingAlternativePaymentRequest(telegramId);
      if (existingRequest) {
        await ctx.answerCallbackQuery();
        await ctx.reply(`Сначала отправьте сообщение по запросу другого способа оплаты для заказа №${existingRequest.orderNumber} или отмените его командой /cancel.`);
        return;
      }
      const request = await orderService.requestAlternativePayment(value, telegramId, action === 'problem' ? 'problem' : 'alternative');
      if (!request) {
        await ctx.reply('Запросить другой способ можно для подтверждённого заказа, если оплата ещё не ожидает проверки.');
        return;
      }
      await ctx.answerCallbackQuery();
      await ctx.reply(action === 'problem'
        ? `Опишите проблему с оплатой заказа №${request.orderNumber}. Сообщение будет отправлено администратору. Для отмены отправьте /cancel.`
        : `Напишите, какой способ оплаты вам подойдёт, или задайте вопрос по оплате заказа №${request.orderNumber}. Сообщение будет отправлено администратору. Для отмены отправьте /cancel.`, {
        reply_markup: { remove_keyboard: true },
      });
      return;
    }
    if (action === 'pub' && value) {
      const parts = ctx.callbackQuery.data.split(':');
      if (value === 'edit') {
        const summary = await orderService.preparePublicationDateEdit(telegramId);
        if (!summary) return;
        await ctx.editMessageText(dateEntryText(summary), { reply_markup: dateEntryKeyboard() });
        return;
      }
      if (value === 'done') {
        const summary = await orderService.summary(telegramId);
        if (!summary) return;
        if (summary.status !== 'ready') {
          await ctx.answerCallbackQuery({ text: 'Сначала укажите дату для каждой публикации.' });
          return;
        }
        await ctx.editMessageText(orderSummaryText(summary), { reply_markup: orderSummaryKeyboard(summary) });
        await ctx.answerCallbackQuery();
        return;
      }
      if (value === 'select') {
        const index = Number(parts[3]);
        const summary = await orderService.summary(telegramId);
        if (!summary || !Number.isInteger(index) || index < 0 || index >= summary.publicationCount) return;
        const selectedDate = summary.publicationDates[index];
        const [year, month] = (selectedDate ? selectedDate.slice(0, 7) : currentIsoDate().slice(0, 7)).split('-').map(Number);
        await ctx.editMessageText(publicationDateEditorText(summary, index), {
          reply_markup: publicationDateEditorKeyboard(summary, index, year, month, parts[4] === 'dateflow'),
        });
        return;
      }
      if (/^\d+$/.test(value)) {
        const index = Number(value);
        const subAction = parts[3];
        const summary = await orderService.summary(telegramId);
        if (!summary || index >= summary.publicationCount) return;
        if (subAction === 'calendar') {
          const month = parseCalendarMonth(parts[4] ?? '');
          if (!month) return;
          await ctx.editMessageText(publicationDateEditorText(summary, index), {
            reply_markup: publicationDateEditorKeyboard(summary, index, month.year, month.month, parts[5] === 'dateflow'),
          });
          return;
        }
        if (subAction === 'calendar_back') {
          if (parts[4] === 'dateflow') {
            await ctx.editMessageText(dateSelectionText(summary), { reply_markup: dateSelectionKeyboard(summary) });
          } else {
            await ctx.editMessageText(publicationDateOverviewText(summary), { reply_markup: publicationDateOverviewKeyboard(summary) });
          }
          return;
        }
        if (subAction === 'noop') {
          await ctx.answerCallbackQuery();
          return;
        }
        if (subAction !== 'pickdate') return;
        const updated = await orderService.setPublicationDate(telegramId, index, parts[4] ?? '');
        if (!updated) return;
        if (updated.status === 'ready') {
          await ctx.editMessageText(orderSummaryText(updated), { reply_markup: orderSummaryKeyboard(updated) });
          return;
        }
        const nextIndex = Math.max(0, updated.publicationDates.findIndex((date) => !date));
        const [year, month] = currentIsoDate().split('-').map(Number);
        await ctx.editMessageText(publicationDateEditorText(updated, nextIndex), {
          reply_markup: publicationDateEditorKeyboard(updated, nextIndex, year, month, parts[5] === 'dateflow'),
        });
        return;
      }
    }
    if (action === 'noop') return;
    if (action === 'calendar' && value) {
      const month = parseCalendarMonth(value);
      if (!month) return;
      await ctx.editMessageText(calendarPrompt, {
        reply_markup: calendarKeyboard(month.year, month.month),
      });
      return;
    }
    if (action === 'calendar_back') {
      const summary = await orderService.summary(telegramId);
      if (summary) await ctx.editMessageText(dateSelectionText(summary), { reply_markup: dateSelectionKeyboard(summary) });
      return;
    }
    if (action === 'pickdate' && value) {
      const result = await orderService.setDate(telegramId, value);
      if (result.kind === 'saved') {
        await ctx.editMessageText(orderSummaryText(result.summary), { reply_markup: orderSummaryKeyboard(result.summary) });
      } else {
        await ctx.reply('Не удалось сохранить дату. Проверьте, что заказ ожидает выбора даты.');
      }
      return;
    }
    if (action === 'select' && value) {
      await service.cancel(telegramId);
      if (!(await startService.hasBusiness(telegramId))) {
        await ctx.reply('Сначала заполните анкету о бизнесе. Выбранный тариф сохранён — после анкеты откроется подтверждение заказа.');
        await beginOnboarding(ctx, service, startService, advertisers, orderService, value);
        return;
      }
      if (!(await orderService.begin(telegramId, value))) {
        await ctx.reply('Не удалось открыть заказ. Проверьте, что тариф активен и бизнес сохранён.');
        return;
      }
      const draft = await orderService.summary(telegramId);
      if (draft?.status === 'ready') {
        await ctx.reply('Тариф изменён. Ранее выбранная дата сохранена; проверьте сводку и при необходимости измените дату перед отправкой заявки.');
        await showOrderSummary(ctx, draft);
      } else {
        await askPlacementDate(ctx, draft);
      }
      return;
    }

    if (action === 'after_payment') {
      const summary = await orderService.agreeAfterPayment(telegramId);
      if (summary) await ctx.editMessageText(orderSummaryText(summary), { reply_markup: orderSummaryKeyboard(summary) });
      return;
    }

    if (action === 'date') {
      const existing = await orderService.summary(telegramId);
      if (existing && existing.publicationCount > 1) {
        const summary = await orderService.preparePublicationDateEdit(telegramId);
        if (summary) {
          await ctx.editMessageText(dateEntryText(summary), { reply_markup: dateEntryKeyboard() });
        }
      } else {
        const summary = await orderService.setAwaitingDate(telegramId);
        if (summary) await ctx.editMessageText(dateEntryText(summary), { reply_markup: dateEntryKeyboard() });
      }
      return;
    }

    if (action === 'confirm') {
      const order = await orderService.confirm(telegramId);
      if (!order) {
        await ctx.reply('Не удалось создать заказ. Откройте каталог и выберите активный тариф.');
        return;
      }
      await notifyNewOrder(ctx.api, adminRepository, order);
      const confirmationText = order.adminTelegramIds.length > 0
        ? `Заказ №${order.orderNumber} отправлен на подтверждение. Инструкции по оплате придут после проверки. После подтверждения оплаты бот попросит материалы.`
        : `Заказ №${order.orderNumber} сохранён, но администраторы не настроены. Подтвердить заказ и оплату сейчас некому.`;
      await ctx.reply(confirmationText, {
        reply_markup: await menuKeyboard(ctx, startService),
      });
      return;
    }

    if (action === 'catalog') {
      await showOrderTariffs(ctx, advertisers, startService);
      return;
    }

    if (action === 'back') {
      await orderService.cancel(telegramId);
      await showTariffs(ctx, advertisers, startService);
      return;
    }

    if ((action === 'paid' || action === 'custom_paid') && value) {
      if (action === 'custom_paid') {
        const proof = await orderService.beginPaymentProof(value, telegramId, 'Другой способ оплаты от администратора');
        if (proof.kind === 'started') await ctx.reply(`Для заказа №${proof.orderNumber} отправьте скриншот или фото чека по переводу.`);
        else if (proof.kind === 'already_reported') await ctx.reply(`Оплата заказа №${proof.orderNumber} уже отправлена администратору.`);
        else await ctx.reply('Сообщить об оплате можно после подтверждения заказа администратором.');
        return;
      }
      const method = config.paymentMethods.find((item) => item.id === methodId);
      if (!method) {
        await ctx.reply(config.paymentMethods.length > 0
          ? 'Сначала выберите способ оплаты.'
          : 'Способ оплаты пока не настроен. Напишите администратору через «Задать вопрос».', {
          ...(config.paymentMethods.length > 0
            ? { reply_markup: paymentMethodsKeyboard(value, config.paymentMethods) }
            : {}),
        });
        return;
      }
      if (requiresTransferScreenshot(method)) {
        const proofRequest = await orderService.beginPaymentProof(value, telegramId, method.title);
        if (proofRequest.kind === 'started') {
          await ctx.reply(`Чтобы сообщить об оплате банковским переводом по заказу №${proofRequest.orderNumber}, отправьте сюда скриншот или фото чека. После получения бот передаст его администратору на проверку. Чтобы отменить, отправьте /cancel.`);
        } else if (proofRequest.kind === 'already_reported') {
          await ctx.reply(`Оплата заказа №${proofRequest.orderNumber} уже отправлена администратору.`);
        } else {
          await ctx.reply('Сообщить об оплате можно после подтверждения заказа администратором.');
        }
        return;
      }
      const payment = await orderService.reportPayment(value, telegramId, method.title);
      if (payment.kind === 'created') {
        await notifyPaymentReported(ctx.api, adminRepository, payment);
        await ctx.reply('Сообщение об оплате принято и отправлено администратору на проверку.', {
          reply_markup: await menuKeyboard(ctx, startService),
        });
      } else if (payment.kind === 'already_reported') {
        await ctx.reply(`Оплата заказа №${payment.orderNumber} уже отправлена администратору.`);
      } else {
        await ctx.reply('Сообщить об оплате можно после подтверждения заказа администратором.');
      }
    }
  });

  bot.callbackQuery(/^tariff:page:(catalog|order):(\d+)$/, async (ctx) => {
    const sender = ctx.from;
    if (!sender || !(await isAdvertiser(ctx, startService))) return;
    const mode = ctx.match[1] as 'catalog' | 'order';
    const index = Number(ctx.match[2]);
    const tariffs = await advertisers.getActiveTariffs(String(sender.id));
    if (tariffs.length === 1) {
      await ctx.answerCallbackQuery({ text: 'Это единственный доступный тариф.' });
      return;
    }
    if (!Number.isInteger(index) || index < 0 || index >= tariffs.length) {
      await ctx.answerCallbackQuery({ text: 'Этот тариф больше недоступен.' });
      if (tariffs.length === 0) {
        await ctx.editMessageText('Активных тарифов пока нет. Напишите нам, и мы подберём формат размещения.', {
          reply_markup: new InlineKeyboard().text('Задать вопрос', 'open_question_topics'),
        });
      }
      return;
    }
    await ctx.editMessageText(tariffCatalogText(tariffs, mode), {
      reply_markup: tariffCatalogKeyboard(tariffs),
      parse_mode: 'HTML',
    });
    await ctx.answerCallbackQuery();
  });

  bot.callbackQuery('tariff:noop', async (ctx) => {
    await ctx.answerCallbackQuery();
  });

  bot.callbackQuery(/^pay:/, async (ctx) => {
    const sender = ctx.from;
    if (!sender || !(await isAdvertiser(ctx, startService))) return;
    const [, first, second] = ctx.callbackQuery.data.split(':');
    if (!first) return;
    if (first === 'methods') {
      const orderId = second;
      if (!orderId) return;
      if (config.paymentMethods.length === 0) {
        await ctx.reply('Способ оплаты пока не настроен. Напишите администратору через «Задать вопрос».');
        return;
      }
      await orderService.schedulePaymentCheckoutReminder(orderId, String(sender.id));
      await ctx.reply('Выберите удобный способ перевода. Если ни один не подходит, нажмите кнопку ниже и напишите администратору — он согласует оплату другим способом:', {
        reply_markup: paymentMethodsKeyboard(orderId, config.paymentMethods),
      });
      return;
    }
    const orderId = first;
    const methodId = second;
    const method = config.paymentMethods.find((item) => item.id === methodId);
    if (!method) {
      await ctx.reply('Этот способ оплаты больше недоступен. Выберите актуальный способ:', {
        reply_markup: paymentMethodsKeyboard(orderId, config.paymentMethods),
      });
      return;
    }
    await orderService.schedulePaymentCheckoutReminder(orderId, String(sender.id));
    const proofInstructions = requiresTransferScreenshot(method)
      ? '\n\nПосле перевода нажмите «Сообщить об оплате» и отправьте скриншот или фото чека — администратор проверит его.'
      : '';
    await ctx.reply(`💳 Оплата заказа\n\nСпособ: ${method.title}\n\n${method.instructions}${proofInstructions}\n\nЕсли удобнее оплатить другим способом, свяжитесь с администратором через кнопку ниже.`, {
      reply_markup: new InlineKeyboard()
        .text('Сообщить об оплате', `order:paid:${orderId}:${method.id}`).row()
        .text('Другой способ — связаться с админом', `order:alternative:${orderId}`).row()
        .text('Сообщить о проблеме', `order:problem:${orderId}`),
    });
  });


}
