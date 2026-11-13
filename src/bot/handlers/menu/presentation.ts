import { InlineKeyboard, type Api, type Context } from 'grammy';
import type { ActiveTariff, SavedInquiry } from '../../../types/advertiser.ts';
import type { AdvertiserRepository } from '../../../db/repositories/advertiser-repository.ts';
import { AdvertiserService, questionTopics } from '../../../services/advertiser-service.ts';
import { OrderService } from '../../../services/order-service.ts';
import type { OrderDraftSummary, UserOrderHistoryItem } from '../../../types/order.ts';
import type { MaterialAnswerResult, MaterialDeliveryReport, OrderMaterialState } from '../../../types/order-material.ts';
import type { OrderMaterialService } from '../../../services/order-material-service.ts';
import type { StartService } from '../../../services/start-service.ts';
import type { AdminRepository } from '../../../db/repositories/admin-repository.ts';
import { createMainMenu } from '../start.ts';
import { config } from '../../../config/env.ts';
import { calendarKeyboard, currentIsoDate } from '../../keyboards/calendar.ts';
import { getMaterialPrompt } from '../../messages/order-material-prompt.ts';
import { notifyMaterialsSubmitted } from '../../../services/admin-notifications.ts';
import { publicationDatesStatusText, publicationDatesText } from '../../../services/publication-dates.ts';
import { isDataDeletionInquiry } from '../../../services/inquiry-topics.ts';
import { customerLabel } from '../../../services/admin-display.ts';

export async function menuKeyboard(ctx: Context, startService: StartService) {
  const sender = ctx.from;
  if (!sender) return undefined;
  const isAdmin = await startService.isAdmin(String(sender.id));
  const hasSubmittedOrder = !isAdmin && await startService.hasSubmittedOrder(String(sender.id));
  const hasSettingsAccess = !isAdmin && await startService.hasNotificationSettingsAccess(String(sender.id));
  return createMainMenu(isAdmin, hasSubmittedOrder, hasSettingsAccess);
}

export async function isAdvertiser(ctx: Context, startService: StartService): Promise<boolean> {
  const sender = ctx.from;
  return Boolean(sender) && !(await startService.isAdmin(String(sender!.id)));
}

export function topicKeyboard(): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  for (const topic of questionTopics) {
    keyboard.text(topic.label, `question:${topic.id}`).row();
  }
  return keyboard;
}

export function backButton(callbackData = 'flow:back'): InlineKeyboard {
  return new InlineKeyboard().text('Назад', callbackData);
}

export async function startTextFlow(ctx: Context, firstPrompt: string): Promise<void> {
  await ctx.reply('Во время заполнения меню скрыто. /cancel отменяет диалог.', {
    reply_markup: { remove_keyboard: true },
  });
  await ctx.reply(firstPrompt, { reply_markup: backButton() });
}

export function escapeHtml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
}

export function tariffText(tariff: ActiveTariff): string {
  const money = (value: string): string => {
    const amount = Number(value);
    try {
      return new Intl.NumberFormat('ru-RU', {
        style: 'currency', currency: tariff.currency.trim(), maximumFractionDigits: 2,
      }).format(amount);
    } catch {
      return `${escapeHtml(value)} ${escapeHtml(tariff.currency.trim())}`;
    }
  };
  const details = [
    tariff.platforms.trim() ? escapeHtml(tariff.platforms.trim()) : '',
    tariff.inclusions.trim() ? escapeHtml(tariff.inclusions.trim()) : '',
    tariff.publicationCount && !tariff.inclusions.trim()
      ? `${tariff.publicationCount} публикаций`
      : '',
    tariff.placementDuration.trim() && !tariff.inclusions.trim()
      ? `Срок: ${escapeHtml(tariff.placementDuration.trim())}`
      : '',
    tariff.description.trim() ? escapeHtml(tariff.description.trim()) : '',
  ].filter(Boolean);
  const price = tariff.discountedPrice
    ? `<s>${money(tariff.price)}</s> → <b>${money(tariff.discountedPrice)}</b>`
    : `<b>${money(tariff.price)}</b>`;
  return [`✨ <b>${escapeHtml(tariff.name)}</b> · ${price}`, details.join('\n')].filter(Boolean).join('\n');
}

export function orderSummaryText(summary: OrderDraftSummary): string {
  const discount = Number(summary.discountAmount) > 0
    ? `Скидка на первое размещение: ${summary.discountAmount} ${summary.currency.trim()}`
    : 'Скидка не применяется';
  return [
    '🧾 Ваш заказ',
    `📦 Тариф: ${summary.name}`,
    '',
    '📌 Условия',
    summary.description || 'Уточняются',
    '',
    '💶 Стоимость',
    `Цена: ${summary.originalPrice} ${summary.currency.trim()}`,
    discount,
    `К оплате: ${summary.finalPrice} ${summary.currency.trim()}`,
    '',
    summary.publicationCount > 1
      ? `📅 Даты публикаций\n${publicationDatesText(summary.publicationDates)}`
      : `📅 Дата публикации\n${publicationDatesText(summary.publicationDates)}`,
    '',
    'После подтверждения оплаты попросим прислать текст рекламы, фото или видео, ссылку или контакт и пожелания к размещению.',
  ].join('\n');
}

export function displayDate(isoDate: string): string {
  const [year, month, day] = isoDate.split('-');
  return `${day}.${month}.${year}`;
}

export function dateSelectionKeyboard(summary?: OrderDraftSummary): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  if ((summary?.publicationCount ?? 1) > 1) {
    keyboard.text('Раз в N дней', 'order:dates:interval:days').row()
      .text('Выбрать день недели', 'order:dates:interval:weeks').row();
  }
  keyboard.text(summary && summary.publicationCount > 1 ? 'Выбрать даты самостоятельно' : 'Выбрать дату самостоятельно', 'order:dates:manual').row()
    .text('Назад', 'order:dates:entry');
  return keyboard;
}

export function dateEntryKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text('Выбрать дату', 'order:dates:choose').row()
    .text('Согласовать после оплаты', 'order:after_payment');
}

export function dateEntryText(summary?: OrderDraftSummary): string {
  return summary && summary.publicationCount > 1
    ? `Для ${summary.publicationCount} публикаций выберите даты или согласуйте их после оплаты.`
    : 'Выберите дату публикации или согласуйте её после оплаты.';
}

export function dateSelectionText(summary?: OrderDraftSummary): string {
  return summary && summary.publicationCount > 1
    ? `Выберите, как назначить даты для ${summary.publicationCount} публикаций.`
    : 'Выберите, как назначить дату публикации.';
}

export function repeatIntervalKeyboard(unit: 'days' | 'weeks'): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  for (let interval = 1; interval <= 12; interval++) {
    const plural = interval % 10 >= 2 && interval % 10 <= 4 && (interval % 100 < 12 || interval % 100 > 14);
    const frequency = unit === 'days'
      ? `Раз в ${interval} ${interval === 1 ? 'день' : plural ? 'дня' : 'дней'}`
      : interval === 1 ? 'Каждую неделю' : `Каждые ${interval} ${plural ? 'недели' : 'недель'}`;
    keyboard.text(frequency, `order:dates:repeat:${unit}:${interval}`);
    if (interval % 3 === 0) keyboard.row();
  }
  return keyboard.text('Назад', 'order:dates:back');
}

export function repeatWeekdayKeyboard(interval: number): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  const weekdays = [
    ['Каждый понедельник', 1], ['Каждый вторник', 2], ['Каждую среду', 3],
    ['Каждый четверг', 4], ['Каждую пятницу', 5], ['Каждую субботу', 6], ['Каждое воскресенье', 7],
  ] as const;
  weekdays.forEach(([label, weekday], index) => {
    keyboard.text(label, `order:dates:weekday:${interval}:${weekday}`);
    if (index % 2 === 1) keyboard.row();
  });
  return keyboard.row().text('Назад', 'order:dates:back');
}

export const calendarPrompt = 'Выберите дату публикации или отправьте её текстом в формате ДД.ММ.ГГГГ / ГГГГ-ММ-ДД.\n× — прошедшая дата, выбрать её нельзя.';

export async function askPlacementDate(ctx: Context, summary?: OrderDraftSummary): Promise<void> {
  await ctx.reply(dateEntryText(summary), { reply_markup: dateEntryKeyboard() });
}

export function publicationDateEditorText(summary: OrderDraftSummary, index: number): string {
  const dates = summary.publicationDates.map((date, itemIndex) =>
    `${itemIndex === index ? '👉 ' : ''}${itemIndex + 1}. ${date ? displayDate(date) : 'дата не выбрана'}`,
  );
  return `Выбор дат публикаций (${index + 1}/${summary.publicationCount})\n\n${dates.join('\n')}\n\nВыберите дату для публикации №${index + 1}. Можно нажать на номер другой публикации выше в кнопках, чтобы изменить её дату.`;
}

export function publicationDateEditorKeyboard(summary: OrderDraftSummary, index: number, year: number, month: number, dateFlow = false): InlineKeyboard {
  const keyboard = calendarKeyboard(year, month, `order:pub:${index}`, currentIsoDate(), dateFlow ? 'dateflow' : undefined);
  keyboard.row();
  for (let itemIndex = 0; itemIndex < summary.publicationCount; itemIndex++) {
    const date = summary.publicationDates[itemIndex] ?? '';
    keyboard.text(`${itemIndex === index ? '👉 ' : ''}${itemIndex + 1}${date ? ' ✓' : ''}`, `order:pub:select:${itemIndex}${dateFlow ? ':dateflow' : ''}`);
    if ((itemIndex + 1) % 4 === 0) keyboard.row();
  }
  keyboard.row();
  if (summary.publicationDates.every(Boolean)) keyboard.text('Сохранить даты', `order:pub:done${dateFlow ? ':dateflow' : ''}`);
  if (!dateFlow) keyboard.text('Согласовать после оплаты', 'order:after_payment');
  keyboard.row().text('Назад', dateFlow ? 'order:dates:back' : 'order:pub:edit');
  return keyboard;
}

export function publicationDateOverviewText(summary: OrderDraftSummary): string {
  return `Даты публикаций:\n${summary.publicationDates.map((date, index) => `${index + 1}. ${date ? displayDate(date) : 'дата не выбрана'}`).join('\n')}\n\nНажмите на номер публикации, чтобы выбрать или изменить дату.`;
}

export function publicationDateOverviewKeyboard(summary: OrderDraftSummary): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  for (let index = 0; index < summary.publicationCount; index++) {
    keyboard.text(`Публикация ${index + 1}${summary.publicationDates[index] ? ' ✓' : ''}`, `order:pub:select:${index}`);
    if ((index + 1) % 2 === 0) keyboard.row();
  }
  keyboard.row();
  if (summary.publicationDates.every(Boolean)) keyboard.text('Сохранить даты', 'order:pub:done');
  return keyboard.text('Согласовать после оплаты', 'order:after_payment');
}

export async function showOrderSummary(ctx: Context, summary: OrderDraftSummary): Promise<void> {
  await ctx.reply(orderSummaryText(summary), { reply_markup: orderSummaryKeyboard(summary) });
}

export function orderSummaryKeyboard(summary: OrderDraftSummary): InlineKeyboard {
  const keyboard = new InlineKeyboard()
    .text('Подтвердить заказ', 'order:confirm').row()
    .text('Выбрать другой тариф', 'order:catalog').row();
  if (summary.publicationCount > 1) keyboard.text('Изменить даты', 'order:pub:edit');
  else keyboard.text('Изменить дату', 'order:date');
  return keyboard.text('Задать вопрос', 'open_question_topics');
}

export function orderProgress(order: UserOrderHistoryItem): { label: string; next: string } {
  if (order.status === 'pending_confirmation') {
    return { label: 'Ожидает подтверждения', next: 'Следующий шаг: администратор проверит заявку и сообщит результат в этом чате.' };
  }
  if (order.status === 'rejected') {
    return { label: 'Отклонён', next: 'Если нужна причина или помощь с новым размещением, нажмите «Задать вопрос».' };
  }
  if (order.status === 'cancelled') {
    return { label: 'Отменён', next: 'Заказ закрыт. Чтобы оформить новое размещение, выберите тариф в меню.' };
  }
  if (order.status === 'completed') {
    return {
      label: 'Опубликован',
      next: order.publicationAt
        ? `Реклама опубликована ${new Date(order.publicationAt).toLocaleString('ru-RU')}. После публикации администратор может запросить отзыв о результате.`
        : 'Реклама отмечена администратором как опубликованная. После публикации администратор может запросить отзыв о результате.',
    };
  }

  if (order.paymentStatus === 'pending_approval') {
    return { label: 'Оплата проверяется', next: 'Следующий шаг: дождитесь проверки оплаты администратором. Результат придёт в этот чат.' };
  }
  if (order.paymentStatus === 'rejected') {
    return { label: 'Оплата отклонена', next: 'Следующий шаг: проверьте оплату и отправьте сообщение об оплате повторно.' };
  }
  if (order.paymentStatus === 'approved') {
    if (order.materialsStatus === 'collecting') {
      return { label: 'Нужно передать материалы', next: 'Следующий шаг: завершите передачу материалов боту. После отправки они будут переданы администратору.' };
    }
    if (order.materialsStatus === 'submitted') {
      return { label: 'Материалы переданы', next: 'Следующий шаг: администратор проверит материал и свяжется с вами по согласованию публикации.' };
    }
    return {
      label: 'Оплата подтверждена',
      next: order.publicationAt
        ? `Следующий шаг: публикация запланирована на ${new Date(order.publicationAt).toLocaleString('ru-RU')}.`
        : 'Следующий шаг: администратор согласует дату и опубликует рекламу.',
    };
  }
  return {
    label: 'Подтверждён',
    next: config.paymentMethods.length > 0
      ? 'Следующий шаг: выберите способ оплаты и следуйте инструкции администратора.'
      : 'Способ оплаты пока не настроен. Напишите администратору через «Задать вопрос».',
  };
}

const userOrderListMessageIds = new Map<string, number[]>();

export async function clearUserOrderListMessages(ctx: Context, telegramId: string): Promise<void> {
  const messageIds = userOrderListMessageIds.get(telegramId) ?? [];
  await Promise.allSettled(messageIds.map((messageId) => ctx.api.deleteMessage(telegramId, messageId)));
  userOrderListMessageIds.delete(telegramId);
}

export async function showUserOrders(
  ctx: Context,
  orderService: OrderService,
  list: 'active' | 'history',
): Promise<void> {
  const sender = ctx.from;
  if (!sender) return;
  const orders = list === 'active'
    ? await orderService.activeOrders(String(sender.id))
    : await orderService.orderHistory(String(sender.id));
  const telegramId = String(sender.id);
  await clearUserOrderListMessages(ctx, telegramId);
  if (orders.length === 0) {
    const message = await ctx.reply(list === 'active'
      ? 'Активных заказов нет. Новые заказы появятся здесь до публикации или отмены.'
      : 'История заказов пока пуста. Завершённые, отклонённые и отменённые заказы будут отображаться здесь.');
    userOrderListMessageIds.set(telegramId, [message.message_id]);
    return;
  }

  const messageIds: number[] = [];
  const heading = await ctx.reply(list === 'active'
    ? `📌 <b>Текущие заказы</b>\nПоказаны активные заказы: ${orders.length}.`
    : `📋 <b>История заказов</b>\nПоказаны последние ${orders.length} завершённых заказов.`, { parse_mode: 'HTML' });
  messageIds.push(heading.message_id);
  for (const order of orders) {
    const progress = orderProgress(order);
    const dateLines = [
      order.requestedPublicationDates.length > 0
        ? publicationDatesStatusText(order.requestedPublicationDates, order.publicationStatuses)
        : undefined,
      order.publicationAt ? `Назначено к публикации: ${new Date(order.publicationAt).toLocaleString('ru-RU')}` : undefined,
    ].filter((line): line is string => line !== undefined);
    const dateLine = dateLines.length > 0 ? `\n${dateLines.join('\n')}` : '';
    const publicationLinkLines = order.publicationLinks.flatMap((link, index) => link
      ? [`🔗 ${order.requestedPublicationDates.length > 1 ? `Публикация ${index + 1}: ` : ''}<a href="${escapeHtml(link)}">Открыть публикацию</a>`]
      : []);
    const text = [
      `🧾 <b>Заказ №${order.orderNumber}</b>`,
      `<b>${escapeHtml(order.tariffName)}</b>`,
      `Стоимость: ${escapeHtml(order.price)} ${escapeHtml(order.currency.trim())}`,
      `Статус: <b>${progress.label}</b>${escapeHtml(dateLine)}`,
      ...publicationLinkLines,
      `\n${escapeHtml(progress.next)}`,
    ].join('\n');
    const keyboard = new InlineKeyboard();
    if (order.materialsStatus === 'collecting') {
      keyboard.text('Продолжить передачу материалов', 'materials:resume').row();
    }
    if (order.status === 'confirmed' && (order.paymentStatus === null || order.paymentStatus === 'rejected')) {
      keyboard.text('Выбрать способ оплаты', `pay:methods:${order.id}`).row();
    }
    if (order.status === 'rejected' || order.paymentStatus === 'rejected') {
      keyboard.text('Задать вопрос', 'open_question_topics');
    }
    if (order.status === 'completed') {
      if (!order.feedbackResponse) {
        keyboard.text('Оставить отзыв', `order:feedback:start:${order.id}`).row();
      } else {
        if (!order.feedbackReview) keyboard.text('Оставить отзыв', `feedback:review:${order.id}`);
        keyboard.text('Написать администратору', `feedback:message:${order.id}`);
        keyboard.row();
      }
    }
    const message = await ctx.reply(text, {
      parse_mode: 'HTML',
      ...(keyboard.inline_keyboard.length > 0 ? { reply_markup: keyboard } : {}),
    });
    messageIds.push(message.message_id);
  }
  userOrderListMessageIds.set(telegramId, messageIds);
}

export async function sendMaterialPrompt(ctx: Context, state: OrderMaterialState): Promise<void> {
  const chatId = ctx.chat?.id;
  if (!chatId) return;
  await sendMaterialPromptTo(ctx.api, chatId, state);
}

export async function sendMaterialPromptWithReuseOffer(
  api: Api,
  chatId: number | string,
  state: OrderMaterialState,
  materialService: OrderMaterialService,
): Promise<void> {
  const previous = await materialService.reusableForOrder(state.orderId);
  if (!previous) {
    await sendMaterialPromptTo(api, chatId, state);
    return;
  }

  if (previous.media.length > 0) {
    try {
      if (previous.media.length === 1) {
        await sendSingleMedia(api, chatId, previous.media[0]!, {});
      } else {
        await api.sendMediaGroup(chatId, previous.media.map((media) => ({
          type: media.kind,
          media: media.fileId,
        })));
      }
    } catch (error) {
      console.error(`Failed to show reusable materials from order ${previous.sourceOrderNumber}:`, error);
    }
  }

  const lines = [
    `В прошлой рекламе «${previous.sourceBusinessName}» (заказ №${previous.sourceOrderNumber}) вы использовали эти материалы:`,
    '',
    previous.adText,
    `Ссылка или контакт: ${previous.destination || 'не указаны'}`,
    `Фото и видео: ${previous.media.length}`,
    `Пожелания: ${previous.wishes || 'нет'}`,
    '',
    `Использовать их для нового заказа №${state.orderNumber}?`,
  ];
  await api.sendMessage(chatId, lines.join('\n'), {
    reply_markup: new InlineKeyboard()
      .text('Использовать прошлые материалы', `materials:reuse:${state.orderId}:${previous.sourceOrderNumber}`).row()
      .text('Отправить новые материалы', `materials:new:${state.orderId}`),
  });
}

const CAPTION_LIMIT = 1024;

export async function sendMaterialPromptTo(api: Api, chatId: number | string, state: OrderMaterialState): Promise<void> {
  if (state.revisionMode && state.step === 6) {
    await sendRevisionPost(api, chatId, state);
  } else if (state.step === 4 && !state.revisionMode) {
    await sendMaterialReview(api, chatId, state);
  } else {
    const prompt = getMaterialPrompt(state);
    await api.sendMessage(chatId, prompt.text, prompt.keyboard ? { reply_markup: prompt.keyboard } : {});
  }
}

async function sendMaterialReview(api: Api, chatId: number | string, state: OrderMaterialState): Promise<void> {
  if (state.media.length > 0) {
    try {
      if (state.media.length === 1) {
        await sendSingleMedia(api, chatId, state.media[0]!, {
          caption: `📎 Фото или видео к заказу №${state.orderNumber}`,
        });
      } else {
        await api.sendMediaGroup(chatId, state.media.map((media, index) => ({
          type: media.kind,
          media: media.fileId,
          ...(index === 0 ? { caption: `📎 Фото и видео к заказу №${state.orderNumber}` } : {}),
        })));
      }
    } catch (error) {
      console.error(`Failed to send material preview for order ${state.orderNumber}:`, error);
    }
  }
  const prompt = getMaterialPrompt(state);
  await api.sendMessage(chatId, prompt.text, prompt.keyboard ? { reply_markup: prompt.keyboard } : {});
}

async function sendRevisionPost(api: Api, chatId: number | string, state: OrderMaterialState): Promise<void> {
  const prompt = getMaterialPrompt(state);
  const keyboard = prompt.keyboard;
  if (state.media.length === 0) {
    await api.sendMessage(chatId, prompt.text, keyboard ? { reply_markup: keyboard } : {});
    return;
  }

  try {
    // A full post fits into the caption: send the materials and the post as one album.
    if (prompt.text.length <= CAPTION_LIMIT) {
      if (state.media.length === 1) {
        const [media] = state.media;
        await sendSingleMedia(api, chatId, media, {
          caption: prompt.text,
          ...(keyboard ? { reply_markup: keyboard } : {}),
        });
        return;
      }
      const messages = await api.sendMediaGroup(chatId, state.media.map((media, index) => ({
        type: media.kind,
        media: media.fileId,
        // Only the current post is shown as a caption; stored file captions may belong to an earlier revision.
        ...(index === 0 ? { caption: prompt.text } : {}),
      })));
      // sendMediaGroup does not accept reply_markup, so the actions are attached to the album afterwards.
      if (keyboard && messages[0]) {
        try {
          await api.editMessageReplyMarkup(chatId, messages[0].message_id, { reply_markup: keyboard });
        } catch (error) {
          console.error(`Failed to attach actions to the album for order ${state.orderNumber}:`, error);
          await api.sendMessage(chatId, 'Выберите, что изменить:', { reply_markup: keyboard });
        }
      }
      return;
    }

    // Caption limit reached: show the materials first, then the full post with actions below them.
    if (state.media.length === 1) {
      await sendSingleMedia(api, chatId, state.media[0], {});
    } else {
      await api.sendMediaGroup(chatId, state.media.map((media) => ({
        type: media.kind,
        media: media.fileId,
      })));
    }
  } catch (error) {
    console.error(`Failed to send revision media for order ${state.orderNumber}:`, error);
  }
  await api.sendMessage(chatId, prompt.text, keyboard ? { reply_markup: keyboard } : {});
}

async function sendSingleMedia(
  api: Api,
  chatId: number | string,
  media: OrderMaterialState['media'][number],
  options: { caption?: string; reply_markup?: InlineKeyboard },
): Promise<void> {
  if (media.kind === 'photo') await api.sendPhoto(chatId, media.fileId, options);
  else await api.sendVideo(chatId, media.fileId, options);
}

/** Moves the revision flow to a new step: removes stale buttons and sends the updated prompt. */
export async function refreshMaterialPrompt(ctx: Context, state: OrderMaterialState): Promise<void> {
  const sourceMessage = ctx.callbackQuery?.message;
  if (sourceMessage && 'text' in sourceMessage && sourceMessage.text && state.revisionMode && state.step === 1) {
    const prompt = getMaterialPrompt(state);
    try {
      await ctx.editMessageText(prompt.text, prompt.keyboard ? { reply_markup: prompt.keyboard } : undefined);
      return;
    } catch {
      // The message could be too old or contain unsupported markup; send a fresh screen below.
    }
  }
  if (sourceMessage) {
    try {
      await ctx.editMessageReplyMarkup({ reply_markup: new InlineKeyboard() });
    } catch {
      // The message could be too old or already updated; the new prompt is still sent below.
    }
  }
  const chatId = ctx.chat?.id;
  if (!chatId) return;
  await sendMaterialPromptTo(ctx.api, chatId, state);
}

export async function forwardMaterialsToAdmins(
  ctx: Context,
  state: OrderMaterialState,
  repository: AdminRepository,
  reusedFromOrderNumber?: string,
): Promise<MaterialDeliveryReport> {
  const delivery = await notifyMaterialsSubmitted(ctx.api, repository, state, reusedFromOrderNumber);
  return { deliveredAdmins: delivery.delivered, failedAdmins: delivery.failed };
}

export async function finishMaterials(
  ctx: Context,
  state: OrderMaterialState,
  startService: StartService,
  repository: AdminRepository,
): Promise<void> {
  const delivery = await forwardMaterialsToAdmins(ctx, state, repository);
  const response = state.adminTelegramIds.length === 0
    ? `Материалы к заказу №${state.orderNumber} сохранены, но администраторы не настроены.`
    : delivery.failedAdmins === 0
      ? `Материалы к заказу №${state.orderNumber} получены и отправлены администраторам. Статус смотрите в меню «Текущие заказы».`
      : delivery.deliveredAdmins > 0
        ? `Материалы к заказу №${state.orderNumber} сохранены. Уведомление доставлено части администраторов; весь пакет доступен в панели «Материалы».`
        : `Материалы к заказу №${state.orderNumber} сохранены. Push-уведомление не доставлено, но пакет доступен администраторам в панели «Материалы».`;
  await ctx.reply(response, {
    reply_markup: await menuKeyboard(ctx, startService),
  });
}

export async function handleMaterialAnswer(
  ctx: Context,
  result: MaterialAnswerResult,
  startService: StartService,
  repository: AdminRepository,
): Promise<void> {
  if (result.kind === 'updated') {
    await sendMaterialPrompt(ctx, result.state);
  } else if (result.kind === 'submitted') {
    await finishMaterials(ctx, result.state, startService, repository);
  } else if (result.kind === 'invalid') {
    await ctx.reply(result.message);
  } else if (result.kind === 'media_step') {
    await ctx.reply('На этом шаге прикрепите фото или видео либо нажмите «Без медиа».');
  }
}

export async function sendInquiryToAdmins(
  ctx: Context,
  inquiry: SavedInquiry,
  repository: AdminRepository,
): Promise<boolean> {
  const sender = ctx.from;
  if (!sender || inquiry.adminTelegramIds.length === 0) return false;
  const details = await repository.getInquiry(inquiry.id);
  if (!details) return false;
  if (isDataDeletionInquiry(details.topic)) return false;
  const keyboard = new InlineKeyboard()
    .text('Ответить', `admin:inquiry_reply:${inquiry.id}`)
    .text('Удалить', `admin:inquiry_delete:${inquiry.id}`);
  const text = [
    `Вопрос: ${details.topic}`,
    `От: ${customerLabel(details.firstName, details.username, details.businessName)}`,
    `Источник: ${details.source}`,
    details.message,
  ].join('\n');
  const results = await Promise.allSettled(inquiry.adminTelegramIds.map((adminId) =>
    ctx.api.sendMessage(adminId, text, { reply_markup: keyboard }),
  ));
  return results.some((result) => result.status === 'fulfilled');
}

export async function sendDataDeletionRequestToAdmins(
  ctx: Context,
  inquiry: SavedInquiry,
): Promise<boolean> {
  const sender = ctx.from;
  if (!sender || inquiry.adminTelegramIds.length === 0) return false;
  const identity = sender.username
    ? `@${sender.username.replace(/^@/, '')}`
    : [sender.first_name, sender.last_name].filter(Boolean).join(' ') || `ID ${sender.id}`;
  const text = [
    '🗑 Запрос на удаление данных',
    `Пользователь: ${identity} · ID ${sender.id}`,
    '',
    'Пользователь просит удалить свои данные из бота.',
    'Ответьте ему или удалите данные пользователя из базы данных.',
  ].join('\n');
  const keyboard = new InlineKeyboard()
    .text('Ответить', `admin:inquiry_reply:${inquiry.id}`)
    .text('Удалить данные', `admin:inquiry_delete:${inquiry.id}`);
  const results = await Promise.allSettled(inquiry.adminTelegramIds.map((adminId) =>
    ctx.api.sendMessage(adminId, text, { reply_markup: keyboard }),
  ));
  return results.some((result) => result.status === 'fulfilled');
}

export async function beginOnboarding(
  ctx: Context,
  service: AdvertiserService,
  startService: StartService,
  advertisers: AdvertiserRepository,
  orderService: OrderService,
  pendingTariffId?: string,
): Promise<void> {
  const sender = ctx.from;
  if (!sender) return;

  if (!(await isAdvertiser(ctx, startService))) return;
  await orderService.cancel(String(sender.id));
  if (await startService.hasBusiness(String(sender.id))) {
    await showOrderTariffs(ctx, advertisers, startService);
    return;
  }

  const firstQuestion = await service.startOnboarding(String(sender.id), pendingTariffId);
  await startTextFlow(ctx, firstQuestion);
}

export async function beginQuestion(ctx: Context): Promise<void> {
  await ctx.reply('Выберите тему вопроса:', { reply_markup: topicKeyboard() });
}

export async function showTariffs(
  ctx: Context,
  advertisers: AdvertiserRepository,
  startService: StartService,
): Promise<void> {
  const sender = ctx.from;
  if (!sender) return;
  const tariffs = await advertisers.getActiveTariffs(String(sender.id));
  if (tariffs.length === 0) {
    await ctx.reply('Тарифы пока не опубликованы. Напишите нам, и мы подберём формат размещения.', {
      reply_markup: new InlineKeyboard().text('Задать вопрос', 'open_question_topics'),
    });
    return;
  }

  await ctx.reply(tariffCatalogText(tariffs, 'catalog'), {
    reply_markup: tariffCatalogKeyboard(tariffs),
    parse_mode: 'HTML',
  });
}

export type TariffCatalogMode = 'catalog' | 'order';

export function tariffCatalogText(tariffs: ActiveTariff[], mode: TariffCatalogMode): string {
  const heading = mode === 'catalog' ? '📣 <b>Форматы размещения</b>' : '🛒 <b>Выберите тариф</b>';
  const intro = mode === 'catalog'
    ? 'Нажмите кнопку с названием тарифа под сообщением, чтобы оформить размещение.'
    : 'Выберите подходящий вариант кнопкой под сообщением.';
  return [heading, intro, ...tariffs.map(tariffText)].join('\n\n');
}

export function tariffCatalogKeyboard(tariffs: ActiveTariff[]): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  for (let index = 0; index < tariffs.length; index++) {
    const tariff = tariffs[index]!;
    const label = tariff.name.length > 48 ? `${tariff.name.slice(0, 47)}…` : tariff.name;
    keyboard.text(label, `order:select:${tariff.id}`);
    if (index % 2 === 1) keyboard.row();
  }
  if (tariffs.length % 2 === 1) keyboard.row();
  return keyboard.text('Задать вопрос', 'open_question_topics');
}

export async function showOrderTariffs(
  ctx: Context,
  advertisers: AdvertiserRepository,
  startService: StartService,
): Promise<void> {
  const sender = ctx.from;
  if (!sender) return;
  const tariffs = await advertisers.getActiveTariffs(String(sender.id));
  if (tariffs.length === 0) {
    await ctx.reply('Активных тарифов пока нет. Администратор должен добавить их в панели.');
    return;
  }

  await ctx.reply(tariffCatalogText(tariffs, 'order'), {
    reply_markup: tariffCatalogKeyboard(tariffs),
    parse_mode: 'HTML',
  });
}

