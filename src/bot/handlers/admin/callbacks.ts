import { Bot, InlineKeyboard, type Context } from 'grammy';
import type { AdminRepository } from '../../../db/repositories/admin-repository.ts';
import type { AdminFlow } from '../../../types/admin.ts';
import { AdminService, tariffFieldLabels } from '../../../services/admin-service.ts';
import type { StartService } from '../../../services/start-service.ts';
import { config } from '../../../config/env.ts';
import type { OrderMaterialService } from '../../../services/order-material-service.ts';
import { sendMaterialPromptWithReuseOffer } from '../menu/presentation.ts';
import { paymentMethodsKeyboard } from '../../keyboards/payment.ts';
import { notificationConsentKeyboard, notificationConsentText } from '../../keyboards/notification-consent.ts';
import { calendarKeyboard, currentIsoDate, parseCalendarMonth } from '../../keyboards/calendar.ts';
import { customerLabel } from '../../../services/admin-display.ts';
import { isDataDeletionInquiry } from '../../../services/inquiry-topics.ts';
import { sendPromotionalBroadcastContent } from '../../../services/promotional-broadcast-delivery.ts';
import { createPromotionalBroadcastDraftToken } from '../../../services/promotional-broadcast-token.ts';
import { DATA_DELETION_RESTART_PARAMETER } from '../start.ts';
import { displayIsoDate, publicationDatesLabel, publicationDatesStatusText } from '../../../services/publication-dates.ts';
import {
  BROADCAST_TIME_ZONE,
  broadcastLocalDateTimeToUtc,
  formatBroadcastDate,
  formatBroadcastDateTime,
  parseBroadcastDate,
} from '../../../services/broadcast-scheduling.ts';
import { adminFlowKeyboard, adminMenuKeyboard, broadcastFlowKeyboard, displayPublicationDate, fromAdmin, isAdmin, publicationNotificationText, sendMaterialSubmissionToAdmin, showAdminMenu, showBusinessLeads, showDataDeletionRequests, showFeedbackList, showFeedbackMenu, showFeedbackThread, showInquiries, showMaterialSubmissions, showMaterialSubmissionsByStatus, showOrders, showPayments, showPublicationSelector, showScheduleCalendar, showTariffs } from './views.ts';

const adminOrderListMessageIds = new Map<string, number[]>();
const tokenizedDraftActions = new Set([
  'preview', 'edit', 'edit_back', 'edit_datetime', 'edit_text', 'edit_media',
  'schedule', 'noop', 'calendar', 'pickdate', 'calendar_back', 'schedule_confirm',
  'edit_discard', 'cancel', 'send', 'media_add', 'media_replace', 'media_clear',
]);
function assertBroadcastCallbackData(data: string): string {
  if (new TextEncoder().encode(data).length > 64) throw new Error('Broadcast callback_data exceeds Telegram 64-byte limit.');
  return data;
}

type BroadcastMediaItem = { type: 'photo' | 'video'; fileId: string };
const changedDraftMessage = 'Черновик изменился, откройте текущую рассылку';
const draftCallback = (action: string, token: string, value?: string) =>
  assertBroadcastCallbackData(`admin:broadcast:${action}${value === undefined ? '' : `:${value}`}:${token}`);

function parseBroadcastMedia(value: string | undefined): BroadcastMediaItem[] {
  try {
    const media = JSON.parse(value ?? '[]') as BroadcastMediaItem[];
    return Array.isArray(media)
      ? media.filter((item) => (item.type === 'photo' || item.type === 'video') && typeof item.fileId === 'string').slice(0, 10)
      : [];
  } catch {
    return [];
  }
}

function parseBroadcastMediaValue(value: unknown): BroadcastMediaItem[] {
  if (typeof value === 'string') return parseBroadcastMedia(value);
  return Array.isArray(value)
    ? value.filter((item): item is BroadcastMediaItem => Boolean(item)
      && ((item as BroadcastMediaItem).type === 'photo' || (item as BroadcastMediaItem).type === 'video')
      && typeof (item as BroadcastMediaItem).fileId === 'string').slice(0, 10)
    : [];
}

export async function scheduledPromotionalBroadcastsPage(
  repository: AdminRepository,
  adminId: string,
  requestedOffset = 0,
): Promise<{ text: string; keyboard: InlineKeyboard }> {
  const pageSize = 10;
  const total = await repository.countPendingPromotionalBroadcasts(adminId);
  const offset = total === 0 ? 0 : Math.min(
    Math.max(0, requestedOffset),
    Math.floor((total - 1) / pageSize) * pageSize,
  );
  const items = await repository.listPendingPromotionalBroadcasts(adminId, pageSize, offset);
  const keyboard = new InlineKeyboard();
  if (items.length === 0) {
    keyboard.text('Создать рассылку', 'admin:broadcast:new').row();
    keyboard.text('Назад', 'admin:broadcast:panel');
    return { text: 'Запланированных рассылок нет.', keyboard };
  }

  const summaries = items.map((item, index) => {
    const media = parseBroadcastMediaValue(item.media);
    const shortText = item.text.replace(/\s+/g, ' ').trim().slice(0, 44);
    const textSuffix = item.text.replace(/\s+/g, ' ').trim().length > 44 ? '…' : '';
    const photos = media.filter((entry) => entry.type === 'photo').length;
    const videos = media.filter((entry) => entry.type === 'video').length;
    const mediaDescription = [photos ? `фото ${photos}` : '', videos ? `видео ${videos}` : ''].filter(Boolean).join(', ');
    const mediaSuffix = mediaDescription ? ` · ${mediaDescription}` : '';
    keyboard.text(`Открыть ${offset + index + 1}`, `admin:broadcast:view_job:${item.id}:${offset}`).row();
    return `${offset + index + 1}. ${formatBroadcastDateTime(item.scheduledAt)} (${BROADCAST_TIME_ZONE}) · ${shortText}${textSuffix}${mediaSuffix}`;
  });
  if (offset > 0) keyboard.text('‹', `admin:broadcast:list:${Math.max(0, offset - pageSize)}`);
  if (offset + items.length < total) keyboard.text('›', `admin:broadcast:list:${offset + pageSize}`);
  keyboard.row().text('Создать рассылку', 'admin:broadcast:new').text('Назад', 'admin:broadcast:panel');
  return {
    text: `Планы рассылок · ${offset + 1}–${offset + items.length} из ${total}\n\n${summaries.join('\n')}`,
    keyboard,
  };
}

export async function promotionalBroadcastPanel(
  repository: AdminRepository,
  adminId: string,
): Promise<{ text: string; keyboard: InlineKeyboard }> {
  const count = await repository.countPendingPromotionalBroadcasts(adminId);
  return {
    text: 'Рекламные рассылки',
    keyboard: new InlineKeyboard()
      .text('Создать рассылку', 'admin:broadcast:new').row()
      .text(`Запланированные (${count})`, 'admin:broadcast:scheduled'),
  };
}

export async function showPromotionalBroadcastPreview(
  ctx: Context,
  repository: AdminRepository,
  adminId: string,
  expectedDraftToken: string,
): Promise<void> {
  const flow = await repository.getFlow(adminId);
  if (!expectedDraftToken || flow?.flowType !== 'promotional_broadcast'
    || flow.payload.draftToken !== expectedDraftToken) {
    await ctx.reply(changedDraftMessage);
    return;
  }
  const token = expectedDraftToken;
  if (!flow.payload.text?.trim()) {
    await ctx.reply('Не удалось открыть предпросмотр. Проверьте, что текст рассылки сохранён.');
    return;
  }
  if (flow.step === 2) {
    await ctx.reply('Рассылка уже отправляется. Дождитесь результата.');
    return;
  }
  const media = parseBroadcastMedia(flow.payload.media);
  if (flow.payload.mode === 'schedule' && !flow.payload.scheduleAt
    && !flow.payload.scheduledBroadcastId && flow.payload.scheduleDateCancelled !== 'true') {
    await repository.savePromotionalDraftFlow(adminId, {
      ...flow,
      step: 5,
      payload: { ...flow.payload, scheduleTimeZone: BROADCAST_TIME_ZONE },
    });
    const minimumDate = formatBroadcastDate(new Date());
    const [year, month] = minimumDate.split('-').map(Number);
    await ctx.reply(`Выберите дату · ${BROADCAST_TIME_ZONE}`, {
      reply_markup: calendarKeyboard(year!, month!, 'admin:broadcast', minimumDate, token),
    });
    return;
  }
  const previewDelivery = await sendPromotionalBroadcastContent(
    ctx.api, adminId, flow.payload.text, media, async () => true,
  );
  if (previewDelivery.kind === 'failed' || previewDelivery.kind === 'partial') {
    throw previewDelivery.error ?? new Error('Promotional broadcast preview was only partially delivered.');
  }
  if (flow.payload.scheduledBroadcastId) {
    const scheduledAt = flow.payload.scheduleAt ? new Date(flow.payload.scheduleAt) : undefined;
    if (!scheduledAt || Number.isNaN(scheduledAt.getTime())) {
      await ctx.reply('Сначала укажите дату и время плана.', {
        reply_markup: new InlineKeyboard()
          .text('Дата и время', draftCallback('edit_datetime', token)).row()
          .text('Отменить изменения', draftCallback('edit_discard', token)),
      });
      return;
    }
    await ctx.reply(`Изменения плана · ${scheduledAt && !Number.isNaN(scheduledAt.getTime())
      ? `${formatBroadcastDateTime(scheduledAt)} (${BROADCAST_TIME_ZONE})`
      : `время не задано (${BROADCAST_TIME_ZONE})`}`, {
      reply_markup: new InlineKeyboard()
        .text('Изменить', draftCallback('edit', token)).text('Сохранить', draftCallback('schedule_confirm', token)).row()
        .text('Отменить изменения', draftCallback('edit_discard', token)),
    });
    return;
  }
  const recipients = await repository.listPromotionalRecipients();
  if (flow.payload.mode === 'schedule') {
    if (!flow.payload.scheduleAt) {
      await ctx.reply(`Предпросмотр · ${recipients.length} получателей · дата не выбрана`, {
        reply_markup: new InlineKeyboard()
          .text('Выбрать дату', draftCallback('schedule', token))
          .text('Изменить', draftCallback('edit', token)).row()
          .text('Отменить', draftCallback('cancel', token)),
      });
      return;
    }
    const scheduledAt = new Date(flow.payload.scheduleAt ?? '');
    await ctx.reply(`Предпросмотр · ${recipients.length} получателей · ${formatBroadcastDateTime(scheduledAt)} (${BROADCAST_TIME_ZONE})`, {
      reply_markup: new InlineKeyboard()
        .text('Изменить', draftCallback('edit', token)).row()
        .text('Подтвердить', draftCallback('schedule_confirm', token)).text('Отменить', draftCallback('cancel', token)),
    });
    return;
  }
  await ctx.reply(`Предпросмотр · ${recipients.length} получателей · медиа ${media.length}`, {
    reply_markup: new InlineKeyboard()
      .text('Изменить', draftCallback('edit', token)).row()
      .text(`Отправить сейчас (${recipients.length})`, draftCallback('send', token)).row()
      .text('Запланировать', draftCallback('schedule', token))
      .text('Отменить', draftCallback('cancel', token)),
  });
}

export function registerAdminCallbackHandlers(bot: Bot, repository: AdminRepository, service: AdminService, startService: StartService, materialService: OrderMaterialService): void {
  bot.callbackQuery(/^admin:/, async (ctx, next) => {
    if (!(await isAdmin(ctx, startService))) return;
    const sender = ctx.from;
    if (!sender) return;
    const adminId = String(sender.id);
    const parts = ctx.callbackQuery.data.split(':');

    if (parts[1] === 'feedback') {
      if (parts[2] === 'menu') {
        await showFeedbackMenu(ctx, repository);
        return;
      }
      if (parts[2] === 'list') {
        const filter = parts[3];
        if (filter === 'all' || filter === 'positive' || filter === 'discussions') {
          await showFeedbackList(ctx, repository, filter);
        }
        return;
      }
      if (parts[2] === 'open' && parts[3]) {
        await showFeedbackThread(ctx, repository, parts[3]);
        return;
      }
      if (parts[2] === 'reply' && parts[3]) {
        const feedback = await repository.getFeedback(parts[3]);
        if (!feedback) {
          await ctx.reply('Отзыв не найден.');
          return;
        }
        const started = await repository.startFeedbackInput(adminId, feedback.orderId, 'admin', 'message');
        if (!started) {
          await ctx.reply('Не удалось открыть ответ по этому отзыву.');
          return;
        }
        await ctx.reply(`Напишите ответ рекламодателю по отзыву заказа №${feedback.orderNumber}.`, { reply_markup: adminFlowKeyboard });
        return;
      }
      if (parts[2] === 'status' && parts[3] && (parts[4] === 'o' || parts[4] === 'c')) {
        await repository.setFeedbackStatus(parts[3], parts[4] === 'c' ? 'closed' : 'open');
        await showFeedbackThread(ctx, repository, parts[3]);
        return;
      }
    }

    if (parts[1] === 'broadcast') {
      if (parts[2] === 'panel') {
        const panel = await promotionalBroadcastPanel(repository, adminId);
        await ctx.editMessageText(panel.text, { reply_markup: panel.keyboard });
        await ctx.answerCallbackQuery();
        return;
      }
      if (parts[2] === 'scheduled') {
        const page = await scheduledPromotionalBroadcastsPage(repository, adminId);
        await ctx.editMessageText(page.text, { reply_markup: page.keyboard });
        await ctx.answerCallbackQuery();
        return;
      }
      if (parts[2] === 'new') {
        await ctx.answerCallbackQuery();
        await ctx.reply('Как отправить рассылку?', {
          reply_markup: new InlineKeyboard()
            .text('Отправить сейчас', 'admin:broadcast:mode:now').row()
            .text('Запланировать', 'admin:broadcast:mode:schedule').row()
            .text('Назад', 'admin:broadcast:panel'),
        });
        return;
      }
      if (parts[2] === 'mode') {
        if (parts[3] !== 'now' && parts[3] !== 'schedule') {
          await ctx.answerCallbackQuery({ text: 'Выберите режим отправки.' });
          return;
        }
        const prompt = await service.startPromotionalBroadcast(adminId, parts[3]);
        await ctx.answerCallbackQuery();
        await ctx.reply(prompt, { reply_markup: broadcastFlowKeyboard });
        return;
      }
      if (parts[2] === 'cancel_job' && parts[3]) {
        const cancelled = await repository.cancelScheduledPromotionalBroadcast(parts[3], adminId);
        await ctx.answerCallbackQuery({ text: cancelled ? 'Отменено.' : 'Уже отправляется или недоступно.' });
        const page = await scheduledPromotionalBroadcastsPage(repository, adminId, Number(parts[4] ?? 0));
        await ctx.editMessageText(cancelled ? `Рассылка отменена.\n\n${page.text}` : `Рассылка уже отправляется или недоступна.\n\n${page.text}`, {
          reply_markup: page.keyboard,
        });
        return;
      }
      if (parts[2] === 'list') {
        const page = await scheduledPromotionalBroadcastsPage(repository, adminId, Number(parts[3] ?? 0));
        await ctx.editMessageText(page.text, { reply_markup: page.keyboard });
        await ctx.answerCallbackQuery();
        return;
      }
      if (parts[2] === 'view_job' && parts[3]) {
        const job = await repository.getPendingPromotionalBroadcast(parts[3], adminId);
        if (!job) {
          await ctx.answerCallbackQuery({ text: 'Задание уже началось или недоступно.' });
          return;
        }
        const media = parseBroadcastMediaValue(job.media);
        await ctx.answerCallbackQuery();
        const previewDelivery = await sendPromotionalBroadcastContent(
          ctx.api, adminId, job.text, media, async () => true,
        );
        if (previewDelivery.kind === 'failed' || previewDelivery.kind === 'partial') {
          throw previewDelivery.error ?? new Error('Scheduled broadcast preview was only partially delivered.');
        }
        await ctx.reply(`${formatBroadcastDateTime(job.scheduledAt)} (${BROADCAST_TIME_ZONE}) · медиа ${media.length}`, {
          reply_markup: new InlineKeyboard()
            .text('Изменить', `admin:broadcast:edit_job:${job.id}`).text('Отменить', `admin:broadcast:cancel_job:${job.id}:${parts[4] ?? 0}`).row()
            .text('К списку', `admin:broadcast:list:${parts[4] ?? 0}`),
        });
        return;
      }
      if (parts[2] === 'edit_job' && parts[3]) {
        const job = await repository.getPendingPromotionalBroadcast(parts[3], adminId);
        if (!job) {
          await ctx.answerCallbackQuery({ text: 'Задание уже началось или недоступно.' });
          return;
        }
        const draftToken = createPromotionalBroadcastDraftToken();
        await repository.saveFlow(adminId, {
          flowType: 'promotional_broadcast',
          step: 7,
          payload: {
            draftToken,
            text: job.text,
            media: JSON.stringify(parseBroadcastMediaValue(job.media)),
            scheduledBroadcastId: job.id,
            scheduleAt: job.scheduledAt.toISOString(),
            scheduleTimeZone: BROADCAST_TIME_ZONE,
          },
        });
        await ctx.answerCallbackQuery();
        await showPromotionalBroadcastPreview(ctx, repository, adminId, draftToken);
        return;
      }
      let flow: AdminFlow | undefined;
      const action = parts[2] ?? '';
      let draftToken: string | undefined;
      if (tokenizedDraftActions.has(action)) {
        draftToken = parts.at(-1);
        if (!draftToken) {
          await ctx.answerCallbackQuery({ text: changedDraftMessage });
          return;
        }
        flow = await repository.getFlow(adminId);
        if (flow?.flowType !== 'promotional_broadcast' || flow.payload.draftToken !== draftToken) {
          await ctx.answerCallbackQuery({ text: changedDraftMessage });
          return;
        }
      }
      if (parts[2] === 'edit_discard') {
        await repository.clearPromotionalDraftFlow(adminId, draftToken!);
        await ctx.answerCallbackQuery({ text: 'Изменения отменены.' });
        const page = await scheduledPromotionalBroadcastsPage(repository, adminId);
        await ctx.reply(page.text, { reply_markup: page.keyboard });
        return;
      }
      flow ??= await repository.getFlow(adminId);
      if (flow?.flowType !== 'promotional_broadcast') {
        await ctx.answerCallbackQuery({ text: 'Сценарий рассылки уже завершён.' });
        return;
      }
      if (parts[2] === 'preview') {
        if (!flow.payload.text?.trim()) {
          await ctx.answerCallbackQuery({ text: 'Сначала добавьте текст рассылки.' });
          return;
        }
        if (flow.step === 2) {
          await ctx.answerCallbackQuery({ text: 'Рассылка уже отправляется.' });
          return;
        }
        await showPromotionalBroadcastPreview(ctx, repository, adminId, draftToken!);
        await ctx.answerCallbackQuery();
        return;
      }
      if (parts[2] === 'edit') {
        if (!flow.payload.text?.trim() || flow.step === 2) {
          await ctx.answerCallbackQuery({ text: 'Сначала добавьте текст рассылки.' });
          return;
        }
        const keyboard = new InlineKeyboard()
          .text('Текст', draftCallback('edit_text', draftToken!))
          .text('Медиа', draftCallback('edit_media', draftToken!));
        if (flow.payload.scheduledBroadcastId || flow.payload.mode === 'schedule') keyboard.row().text('Дата и время', draftCallback('edit_datetime', draftToken!));
        keyboard.row().text('Назад', draftCallback('edit_back', draftToken!));
        await ctx.answerCallbackQuery();
        await ctx.reply('Что изменить?', { reply_markup: keyboard });
        return;
      }
      if (parts[2] === 'edit_back') {
        await ctx.answerCallbackQuery();
        await showPromotionalBroadcastPreview(ctx, repository, adminId, draftToken!);
        return;
      }
      if (parts[2] === 'edit_datetime') {
        if ((!flow.payload.scheduledBroadcastId && flow.payload.mode !== 'schedule') || flow.step === 2) {
          await ctx.answerCallbackQuery({ text: 'Редактирование времени недоступно.' });
          return;
        }
        if (flow.payload.scheduledBroadcastId) {
          const job = await repository.getPendingPromotionalBroadcast(flow.payload.scheduledBroadcastId, adminId);
          if (!job) {
            await ctx.answerCallbackQuery({ text: 'Задание уже началось или недоступно.' });
            return;
          }
        }
        const payload = {
          ...flow.payload,
          originalScheduleAt: flow.payload.scheduleAt ?? '',
          scheduleAt: '',
          scheduleDate: '',
          scheduleTime: '',
        };
        await repository.savePromotionalDraftFlow(adminId, { ...flow, step: 5, payload });
        await ctx.answerCallbackQuery();
        const minimumDate = formatBroadcastDate(new Date());
        const [year, month] = minimumDate.split('-').map(Number);
        await ctx.reply(`Выберите новую дату · ${BROADCAST_TIME_ZONE}`, {
          reply_markup: calendarKeyboard(year!, month!, 'admin:broadcast', minimumDate, draftToken),
        });
        return;
      }
      if (parts[2] === 'edit_text') {
        if (flow.step === 2) {
          await ctx.answerCallbackQuery({ text: 'Рассылка уже отправляется.' });
          return;
        }
        await repository.savePromotionalDraftFlow(adminId, { ...flow, step: 3 });
        await ctx.answerCallbackQuery();
        await ctx.reply('Отправьте новый текст. Медиа сохранятся.', { reply_markup: broadcastFlowKeyboard });
        return;
      }
      if (parts[2] === 'schedule') {
        if (flow.step === 2) {
          await ctx.answerCallbackQuery({ text: 'Рассылка уже отправляется.' });
          return;
        }
        if (!flow.payload.text?.trim()) {
          await ctx.answerCallbackQuery({ text: 'Сначала добавьте текст рассылки.' });
          return;
        }
        const payload: Record<string, string> = { ...flow.payload, scheduleTimeZone: BROADCAST_TIME_ZONE };
        delete payload.scheduleDateCancelled;
        await repository.savePromotionalDraftFlow(adminId, { ...flow, step: 5, payload });
        await ctx.answerCallbackQuery();
        const minimumDate = formatBroadcastDate(new Date());
        const [year, month] = minimumDate.split('-').map(Number);
        await ctx.reply(`Выберите дату отправки в календаре. Часовой пояс: ${BROADCAST_TIME_ZONE}.`, {
          reply_markup: calendarKeyboard(year!, month!, 'admin:broadcast', minimumDate, draftToken),
        });
        return;
      }
      if (parts[2] === 'noop') {
        await ctx.answerCallbackQuery();
        return;
      }
      if (parts[2] === 'calendar') {
        if (flow.step !== 5) {
          await ctx.answerCallbackQuery({ text: 'Выбор даты завершён. Откройте предпросмотр заново.' });
          return;
        }
        const minimumDate = formatBroadcastDate(new Date());
        const month = parseCalendarMonth(parts[3] ?? '', minimumDate);
        if (!month) {
          await ctx.answerCallbackQuery({ text: 'Этот месяц выбрать нельзя.' });
          return;
        }
        await ctx.editMessageReplyMarkup({
          reply_markup: calendarKeyboard(month.year, month.month, 'admin:broadcast', minimumDate, draftToken),
        });
        await ctx.answerCallbackQuery();
        return;
      }
      if (parts[2] === 'pickdate') {
        if (flow.step !== 5) {
          await ctx.answerCallbackQuery({ text: 'Выбор даты завершён. Откройте предпросмотр заново.' });
          return;
        }
        const date = parseBroadcastDate(parts[3] ?? '');
        if (!date) {
          const minimumDate = formatBroadcastDate(new Date());
          const [year, month] = minimumDate.split('-').map(Number);
          await ctx.answerCallbackQuery({ text: 'Нельзя выбрать прошедшую или некорректную дату.' });
          await ctx.editMessageReplyMarkup({
            reply_markup: calendarKeyboard(year!, month!, 'admin:broadcast', minimumDate, draftToken),
          });
          return;
        }
        await repository.savePromotionalDraftFlow(adminId, {
          ...flow,
          step: 6,
          payload: { ...flow.payload, scheduleDate: date },
        });
        await ctx.answerCallbackQuery();
        await ctx.editMessageText(`Выбрана дата: ${date} (${BROADCAST_TIME_ZONE}).`);
        await ctx.reply(`Введите время отправки в формате ЧЧ:ММ, например 18:30. Часовой пояс: ${BROADCAST_TIME_ZONE}.`, {
          reply_markup: broadcastFlowKeyboard,
        });
        return;
      }
      if (parts[2] === 'calendar_back') {
        if (flow.step !== 5) {
          await ctx.answerCallbackQuery({ text: 'Выбор даты уже завершён.' });
          return;
        }
        const payload = { ...flow.payload };
        delete payload.scheduleDate;
        delete payload.scheduleTime;
        const preserveScheduledTime = Boolean(payload.scheduledBroadcastId)
          || (payload.mode === 'schedule' && Boolean(payload.scheduleAt));
        if (payload.scheduledBroadcastId && !payload.scheduleAt && payload.originalScheduleAt) {
          payload.scheduleAt = payload.originalScheduleAt;
        }
        delete payload.originalScheduleAt;
        if (!preserveScheduledTime) delete payload.scheduleAt;
        if (payload.mode === 'schedule' && !preserveScheduledTime) payload.scheduleDateCancelled = 'true';
        else delete payload.scheduleDateCancelled;
        await repository.savePromotionalDraftFlow(adminId, { ...flow, step: preserveScheduledTime ? 7 : 1, payload });
        await ctx.answerCallbackQuery();
        if (preserveScheduledTime) {
          await showPromotionalBroadcastPreview(ctx, repository, adminId, draftToken!);
        } else {
          await ctx.editMessageText('Дата не выбрана.', {
            reply_markup: new InlineKeyboard()
              .text('Выбрать дату', draftCallback('schedule', draftToken!))
              .text('Изменить', draftCallback('edit', draftToken!)).row()
              .text('Отменить', draftCallback('cancel', draftToken!)),
          });
        }
        return;
      }
      if (parts[2] === 'schedule_confirm') {
        const existingId = flow.payload.scheduledBroadcastId;
        const canConfirmEdit = Boolean(existingId) && [1, 7].includes(flow.step);
        if ((!existingId && flow.step !== 7) || (existingId && !canConfirmEdit) || !flow.payload.scheduleAt) {
          await ctx.answerCallbackQuery({ text: existingId ? 'Сначала завершите изменения даты и текста.' : 'Сначала укажите дату и время.' });
          return;
        }
        const scheduledAt = new Date(flow.payload.scheduleAt);
        if (Number.isNaN(scheduledAt.getTime()) || scheduledAt.getTime() <= Date.now()) {
          await repository.savePromotionalDraftFlow(adminId, { ...flow, step: 6, payload: { ...flow.payload, scheduleAt: '' } });
          await ctx.answerCallbackQuery({ text: 'Это время уже прошло. Введите время заново.' });
          await ctx.reply(`Введите время отправки в формате ЧЧ:ММ (${BROADCAST_TIME_ZONE}).`, { reply_markup: broadcastFlowKeyboard });
          return;
        }
        const media = parseBroadcastMedia(flow.payload.media);
        let saved;
        try {
          saved = await repository.confirmPromotionalBroadcastSchedule(
            adminId, flow, flow.payload.text ?? '', media, scheduledAt,
          );
        } catch (error) {
          console.error(`Could not confirm promotional broadcast schedule for admin ${adminId}:`, error);
          await ctx.answerCallbackQuery({ text: 'Не удалось сохранить. Попробуйте ещё раз.' });
          await ctx.reply('План не сохранён. Попробуйте подтвердить ещё раз.');
          return;
        }
        if (saved.kind === 'conflict') {
          await ctx.answerCallbackQuery({ text: 'План уже подтверждён.' });
          return;
        }
        if (saved.kind === 'unavailable') {
          await ctx.answerCallbackQuery({ text: 'Задание уже началось или недоступно.' });
          await ctx.reply('Рассылка уже отправляется или её нельзя изменить.');
          return;
        }
        if (existingId) {
          await ctx.answerCallbackQuery({ text: 'Изменения сохранены.' });
          const page = await scheduledPromotionalBroadcastsPage(repository, adminId);
          await ctx.reply(`Изменения плана сохранены.\n\n${page.text}`, { reply_markup: page.keyboard });
        } else {
          await ctx.answerCallbackQuery({ text: 'Запланировано.' });
          await ctx.reply(`Запланировано: ${formatBroadcastDateTime(saved.scheduledAt)} (${BROADCAST_TIME_ZONE}).`, {
            reply_markup: new InlineKeyboard().text('Отменить рассылку', `admin:broadcast:cancel_job:${saved.id}`),
          });
        }
        return;
      }
      if (parts[2] === 'edit_media') {
        if (flow.step === 2) {
          await ctx.answerCallbackQuery({ text: 'Рассылка уже отправляется.' });
          return;
        }
        await ctx.answerCallbackQuery();
        await ctx.reply('Как изменить медиа в рассылке?', {
          reply_markup: new InlineKeyboard()
            .text('Заменить', draftCallback('media_replace', draftToken!))
            .text('Добавить', draftCallback('media_add', draftToken!)).row()
            .text('Удалить все медиа', draftCallback('media_clear', draftToken!)).row()
            .text('К предпросмотру', draftCallback('preview', draftToken!)),
        });
        return;
      }
      if (parts[2] === 'media_add' || parts[2] === 'media_replace') {
        if (flow.step === 2) {
          await ctx.answerCallbackQuery({ text: 'Рассылка уже отправляется.' });
          return;
        }
        const replace = parts[2] === 'media_replace';
        await repository.savePromotionalDraftFlow(adminId, {
          ...flow,
          step: 4,
          payload: { ...flow.payload, ...(replace ? { media: '[]' } : {}) },
        });
        await ctx.answerCallbackQuery();
        await ctx.reply(replace
          ? 'Отправьте новые фото и видео (до 10). Текст рассылки сохранён.'
          : 'Отправьте фото и видео для добавления (всего не более 10). Текст рассылки сохранён.', {
          reply_markup: new InlineKeyboard().text('К предпросмотру', draftCallback('preview', draftToken!)),
        });
        return;
      }
      if (parts[2] === 'media_clear') {
        if (flow.step === 2) {
          await ctx.answerCallbackQuery({ text: 'Рассылка уже отправляется.' });
          return;
        }
        await repository.savePromotionalDraftFlow(adminId, {
          ...flow,
          step: 1,
          payload: { ...flow.payload, media: '[]' },
        });
        await ctx.answerCallbackQuery({ text: 'Медиа удалено.' });
        await ctx.reply('Все медиа удалены из рассылки. Текст сохранён.', {
          reply_markup: new InlineKeyboard().text('К предпросмотру', draftCallback('preview', draftToken!)),
        });
        return;
      }
      if (parts[2] === 'cancel') {
        await repository.clearPromotionalDraftFlow(adminId, draftToken!);
        const panel = await promotionalBroadcastPanel(repository, adminId);
        await ctx.answerCallbackQuery({ text: 'Создание отменено.' });
        await ctx.reply(panel.text, { reply_markup: panel.keyboard });
        return;
      }
      if (parts[2] === 'send') {
        if (flow.step === 2) {
          await ctx.answerCallbackQuery({ text: 'Рассылка уже отправляется.' });
          return;
        }
        if (flow.step < 1 || !flow.payload.text?.trim()) {
          await ctx.answerCallbackQuery({ text: 'Сначала добавьте текст рассылки.' });
          return;
        }
        const claimToken = await repository.claimPromotionalBroadcast(adminId, flow);
        if (!claimToken) {
          await ctx.answerCallbackQuery({ text: 'Рассылка уже отправляется или сценарий изменился.' });
          return;
        }
        await ctx.answerCallbackQuery({ text: 'Начинаю отправку.' });
        const recipients = await repository.listPromotionalRecipients();
        const media = parseBroadcastMedia(flow.payload.media);
        let sent = 0;
        let partial = 0;
        let failed = 0;
        let skipped = 0;
        for (const recipientId of recipients) {
          const result = await sendPromotionalBroadcastContent(
            ctx.api,
            recipientId,
            flow.payload.text,
            media,
            () => repository.hasPromotionalConsent(recipientId),
          );
          if (result.kind === 'delivered') sent += 1;
          else if (result.kind === 'partial') {
            partial += 1;
            if (result.error) console.error(`Could not finish promotional broadcast for Telegram user ${recipientId}:`, result.error);
          } else if (result.kind === 'failed') {
            failed += 1;
            console.error(`Could not send promotional broadcast to Telegram user ${recipientId}:`, result.error);
          } else {
            skipped += 1;
          }
          await new Promise((resolve) => setTimeout(resolve, 40));
        }
        await repository.clearClaimedPromotionalBroadcast(adminId, claimToken);
        await ctx.reply(`Рассылка: доставлено ${sent}, частично ${partial}, не доставлено ${failed}, пропущено ${skipped}.`, {
          reply_markup: adminMenuKeyboard(),
        });
        return;
      }
    }

    if (parts[1] === 'md') {
      const showDateEditor = async (orderId: string): Promise<boolean> => {
        const order = await repository.getOrderDateInfo(orderId);
        if (!order) {
          await ctx.reply('Заказ не найден. Обновите список заказов.');
          return false;
        }
        const keyboard = new InlineKeyboard();
        order.publicationDates.forEach((date, index) => {
          const dateStatus = order.publicationDateStatuses[index] ?? (date ? 'confirmed' : 'awaiting_admin');
          const label = !date ? 'назначить дату' : dateStatus === 'awaiting_user'
            ? `ждёт согласия · ${displayIsoDate(date)}`
            : `согласована · ${displayIsoDate(date)}`;
          keyboard.text(`Публикация ${index + 1}: ${label}`, `admin:md:edit:${order.id}:${index}`);
          if ((index + 1) % 2 === 0) keyboard.row();
        });
        keyboard.row().text('Готово', `admin:md:close:${order.id}`);
        await ctx.reply(`Изменение дат заказа №${order.orderNumber}\n${publicationDatesLabel(order.publicationDates)}\n\nВыберите публикацию:`, { reply_markup: keyboard });
        return true;
      };

      if (parts[2] === 'close') {
        await repository.clearFlow(adminId);
        const order = parts[3] ? await repository.getOrderDateInfo(parts[3]) : undefined;
        if (order) {
          await ctx.editMessageText(`Редактирование дат заказа №${order.orderNumber} завершено.\n${publicationDatesLabel(order.publicationDates)}`, {
            reply_markup: new InlineKeyboard(),
          });
        } else {
          await ctx.editMessageText('Редактирование дат завершено. Выбранные даты сохраняются сразу после выбора.', {
            reply_markup: new InlineKeyboard(),
          });
        }
        await ctx.answerCallbackQuery();
        return;
      }
      if (parts[2] === 'open' && parts[3]) {
        await showDateEditor(parts[3]);
        return;
      }
      if (parts[2] === 'edit' && parts[3] && parts[4]) {
        const order = await repository.getOrderDateInfo(parts[3]);
        const index = Number(parts[4]);
        if (!order || !Number.isInteger(index) || index < 0 || index >= order.publicationDates.length) {
          await ctx.reply('Публикация не найдена. Откройте редактирование дат заново.');
          return;
        }
        await repository.saveFlow(adminId, {
          flowType: 'edit_publication_date',
          step: 0,
          payload: { orderId: order.id, publicationIndex: String(index) },
        });
        const [year, month] = currentIsoDate().split('-').map(Number);
        await ctx.reply(`Выберите новую дату для публикации ${index + 1} заказа №${order.orderNumber}.`, {
          reply_markup: calendarKeyboard(year, month, 'admin:md'),
        });
        return;
      }
      if (parts[2] === 'calendar' && parts[3]) {
        const flow = await repository.getFlow(adminId);
        if (flow?.flowType !== 'edit_publication_date') {
          await ctx.reply('Сценарий изменения даты завершён. Откройте редактирование дат заново.');
          return;
        }
        const month = parseCalendarMonth(parts[3]);
        if (!month) return;
        await ctx.editMessageReplyMarkup({
          reply_markup: calendarKeyboard(month.year, month.month, 'admin:md'),
        });
        return;
      }
      if (parts[2] === 'calendar_back') {
        const flow = await repository.getFlow(adminId);
        await repository.clearFlow(adminId);
        if (flow?.flowType === 'edit_publication_date' && flow.payload.orderId) {
          await showDateEditor(flow.payload.orderId);
        }
        return;
      }
      if (parts[2] === 'pickdate' && parts[3]) {
        const flow = await repository.getFlow(adminId);
        const orderId = flow?.flowType === 'edit_publication_date' ? flow.payload.orderId : undefined;
        const index = flow?.flowType === 'edit_publication_date' ? Number(flow.payload.publicationIndex) : NaN;
        const date = parts[3];
        const isIsoDate = /^\d{4}-\d{2}-\d{2}$/.test(date);
        const dateObject = isIsoDate ? new Date(`${date}T00:00:00.000Z`) : undefined;
        const isValidDate = Boolean(dateObject && !Number.isNaN(dateObject.getTime()) && dateObject.toISOString().slice(0, 10) === date);
        const updated = orderId && Number.isInteger(index) && isValidDate && date >= currentIsoDate()
          ? await repository.updateOrderPublicationDate(orderId, index, date)
          : undefined;
        if (!updated) {
          await ctx.reply('Не удалось изменить дату. Сценарий мог завершиться или публикация уже недоступна. Откройте редактирование дат заново.');
          return;
        }
        await repository.clearFlow(adminId);
        await Promise.allSettled([
          ctx.api.sendMessage(
            updated.telegramId,
            fromAdmin(`Администратор предложил дату публикации ${index + 1} по заказу №${updated.orderNumber}: ${displayIsoDate(date)}. Подтвердите дату или попросите изменить её. Публикацию можно будет отметить после согласования.`),
            { reply_markup: new InlineKeyboard()
              .text('Подтвердить дату', `odc:${orderId}:${index}:${date}`).row()
              .text('Попросить изменить', `odx:${orderId}:${index}:${date}`) },
          ),
          ctx.editMessageText(`Дата публикации ${index + 1} заказа №${updated.orderNumber} изменена на ${displayIsoDate(date)}.`),
        ]);
        if (orderId) await showDateEditor(orderId);
        return;
      }
      await ctx.reply('Не удалось открыть изменение даты. Откройте пакет материалов заново.');
      return;
    }

    if (parts[1] === 'publish' && parts[2] === 'no_link') {
      await ctx.answerCallbackQuery();
      const result = await service.answer(adminId, 'без ссылки');
      if (!result || result.kind !== 'done') {
        await ctx.reply(result?.kind === 'invalid' ? result.text : 'Не удалось отметить публикацию. Откройте действие заново.');
        return;
      }
      if (result.publicationNotification) {
        const publication = result.publicationNotification;
        await Promise.allSettled([
          ctx.api.sendMessage(
            publication.telegramId,
            fromAdmin(publicationNotificationText(publication)),
          ),
          ctx.editMessageText(result.text, { reply_markup: new InlineKeyboard() }),
        ]);
      } else {
        await ctx.editMessageText(result.text, { reply_markup: new InlineKeyboard() });
      }
      await showAdminMenu(ctx, repository);
      return;
    }
    if (parts[1] === 'publish' && parts[2] === 'cancel') {
      await ctx.answerCallbackQuery();
      await service.cancel(adminId);
      await ctx.editMessageText('Отметка публикации отменена.', { reply_markup: new InlineKeyboard() });
      await showAdminMenu(ctx, repository);
      return;
    }
    if (parts[1] === 'pubsel' && parts[2] === 'back' && parts[3]) {
      await service.cancel(adminId);
      await showPublicationSelector(ctx, repository, parts[3], true);
      await ctx.answerCallbackQuery();
      return;
    }
    if (parts[1] === 'pubsel' && parts[2] && parts[3] !== undefined) {
      const order = await repository.getOrderDateInfo(parts[2]);
      const publicationIndex = Number(parts[3]);
      if (!order || order.status !== 'confirmed' || !Number.isInteger(publicationIndex)
        || publicationIndex < 0 || publicationIndex >= order.publicationDates.length
        || order.publicationStatuses[publicationIndex] === 'published'
        || !order.publicationDates[publicationIndex]
        || (order.publicationDateStatuses[publicationIndex] ?? 'awaiting_admin') !== 'confirmed') {
        await ctx.reply('Эта публикация уже отмечена или заказ не найден. Обновите список публикаций.');
        return;
      }
      await ctx.editMessageText(await service.startPublishOrder(adminId, order.id, publicationIndex), {
        reply_markup: new InlineKeyboard()
          .text('Без ссылки', 'admin:publish:no_link')
          .text('Назад', `admin:pubsel:back:${order.id}`),
      });
      await ctx.answerCallbackQuery();
      return;
    }

    if (parts[1] === 'payreq' && (parts[2] === 'r' || parts[2] === 'i') && parts[3]) {
      const request = await repository.getPaymentMethodRequest(parts[3]);
      if (!request) {
        await ctx.reply('Запрос уже обработан или заказ не найден.');
        return;
      }
      const instructionsMode = parts[2] === 'i';
      const context = instructionsMode
        ? `Оплата заказа №${request.orderNumber}: ${request.amount} ${request.currency.trim()}. Ниже отправьте согласованные реквизиты и назначение платежа. Покупателю будет добавлена кнопка для отправки чека.`
        : `Ответ администратора по запросу другого способа оплаты для заказа №${request.orderNumber}.`;
      await ctx.reply(await service.startMessage(
        adminId,
        request.telegramId,
        undefined,
        undefined,
        undefined,
        context,
        customerLabel(request.firstName, request.username, request.businessName),
        request.requestId,
        request.orderId,
        instructionsMode ? 'instructions' : 'plain',
      ), { reply_markup: adminFlowKeyboard });
      await ctx.answerCallbackQuery();
      return;
    }

    if (parts[1] === 'tariff' && parts[2] === 'add') {
      await ctx.reply(await service.startTariffCreate(adminId), { reply_markup: adminFlowKeyboard });
      return;
    }
    if (parts[1] === 'tariff' && parts[2] === 'edit' && parts[3]) {
      const prompt = await service.startTariffEdit(adminId, parts[3]);
      if (prompt) await ctx.reply(prompt, { reply_markup: adminFlowKeyboard });
      return;
    }
    if (parts[1] === 'tariff' && parts[2] === 'fields' && parts[3]) {
      const tariff = (await repository.listTariffs()).find((item) => item.id === parts[3]);
      if (!tariff) {
        await ctx.reply('Тариф не найден.');
        return;
      }
      const keyboard = new InlineKeyboard();
      tariffFieldLabels.forEach((label, field) => {
        keyboard.text(label, `admin:tariff:field:${tariff.id}:${field}`);
        if (keyboard.inline_keyboard.at(-1)?.length === 2) keyboard.row();
      });
      await ctx.reply(`Какой пункт изменить в тарифе «${tariff.name}»?`, { reply_markup: keyboard });
      return;
    }
    if (parts[1] === 'tariff' && parts[2] === 'field' && parts[3] && parts[4]) {
      const prompt = await service.startTariffEditField(adminId, parts[3], Number(parts[4]));
      if (prompt) await ctx.reply(prompt, { reply_markup: adminFlowKeyboard });
      else await ctx.reply('Не удалось открыть выбранный пункт тарифа.');
      return;
    }
    if (parts[1] === 'tariff' && parts[2] === 'delete' && parts[3]) {
      const tariff = (await repository.listTariffs()).find((item) => item.id === parts[3]);
      if (!tariff) {
        await ctx.reply('Тариф уже удалён или не найден.');
        return;
      }
      await ctx.reply(`Удалить тариф «${tariff.name}»?`, {
        reply_markup: new InlineKeyboard()
          .text('Да, удалить', `admin:tariff:delete_confirm:${tariff.id}`)
          .text('Отмена', 'admin:tariff:delete_cancel'),
      });
      return;
    }
    if (parts[1] === 'tariff' && parts[2] === 'delete_cancel') {
      await showTariffs(ctx, repository);
      return;
    }
    if (parts[1] === 'tariff' && parts[2] === 'delete_confirm' && parts[3]) {
      const result = await repository.deleteTariff(parts[3]);
      await ctx.reply(result === 'deleted'
        ? 'Тариф удалён.'
        : result === 'referenced'
          ? 'Этот тариф уже связан с заказами или активной заявкой, поэтому удалить его нельзя. Отключите тариф — он перестанет показываться покупателям, а история заказов сохранится.'
          : 'Тариф уже удалён или не найден.');
      await showTariffs(ctx, repository);
      return;
    }
    if (parts[1] === 'tariff' && parts[2] === 'toggle' && parts[3]) {
      const tariff = (await repository.listTariffs()).find((item) => item.id === parts[3]);
      if (!tariff) return;
      await repository.setTariffActive(tariff.id, !tariff.isActive);
      await ctx.reply(tariff.isActive ? 'Тариф отключён.' : 'Тариф включён.');
      return;
    }
    if (parts[1] === 'leads' && parts[2] === 'all') {
      await showBusinessLeads(ctx, repository);
      return;
    }
    if (parts[1] === 'leads' && parts[2] === 'search') {
      await ctx.reply(await service.startBusinessFilter(adminId), { reply_markup: adminFlowKeyboard });
      return;
    }
    if (parts[1] === 'inquiries') {
      await showInquiries(ctx, repository);
      return;
    }
    if (parts[1] === 'data_deletion') {
      await showDataDeletionRequests(ctx, repository);
      return;
    }
    if (parts[1] === 'inquiry_reply' && parts[2]) {
      const inquiry = await repository.getInquiry(parts[2]);
      if (!inquiry) {
        await ctx.reply('Вопрос уже удалён или не найден.');
        return;
      }
      const excerpt = inquiry.message.length > 180 ? `${inquiry.message.slice(0, 179)}…` : inquiry.message;
      const context = `Ответ на вопрос «${inquiry.topic}» от ${new Date(inquiry.createdAt).toLocaleString('ru-RU')}: «${excerpt}»`;
      await ctx.reply(await service.startMessage(
        adminId,
        inquiry.telegramId,
        inquiry.id,
        undefined,
        inquiry.topic,
        context,
        customerLabel(inquiry.firstName, inquiry.username, inquiry.businessName),
      ), { reply_markup: adminFlowKeyboard });
      return;
    }
    if (parts[1] === 'inquiry_delete' && parts[2]) {
      const inquiry = await repository.getInquiry(parts[2]);
      const isDataDeletionRequest = Boolean(inquiry && isDataDeletionInquiry(inquiry.topic));
      const deleted = isDataDeletionRequest
        ? await repository.deleteUserDataForInquiry(parts[2])
        : await repository.deleteInquiry(parts[2]);
      let userNotified: boolean | undefined;
      if (deleted && isDataDeletionRequest && inquiry) {
        const restartKeyboard = ctx.me.username
          ? new InlineKeyboard().url(
            'Запустить бота заново',
            `https://t.me/${ctx.me.username}?start=${DATA_DELETION_RESTART_PARAMETER}`,
          )
          : undefined;
        try {
          await ctx.api.sendMessage(
            inquiry.telegramId,
            'Ваши данные удалены по вашему запросу. Чтобы начать заново и снова увидеть тарифы, нажмите кнопку или отправьте /start.',
            restartKeyboard ? { reply_markup: restartKeyboard } : {},
          );
          userNotified = true;
        } catch (error) {
          console.error(`Could not notify user ${inquiry.telegramId} after data deletion:`, error);
          userNotified = false;
        }
      }
      const deletedMessage = isDataDeletionRequest
        ? userNotified
          ? 'Данные пользователя удалены. Ему отправлено уведомление с кнопкой перезапуска бота.'
          : 'Данные пользователя удалены, но уведомление отправить не удалось.'
        : 'Вопрос удалён из списка.';
      await ctx.reply(deleted ? deletedMessage : 'Обращение уже удалено или не найдено.', {
        reply_markup: adminMenuKeyboard(),
      });
      return;
    }
    if (parts[1] === 'payments') {
      await showPayments(ctx, repository);
      return;
    }
    if (parts[1] === 'orders' && parts[2] === 'open' && parts[3]) {
      const order = (await repository.listOrders('pending_confirmation')).find((item) => item.id === parts[3]);
      if (!order) {
        await ctx.reply('Заказ уже обработан или не найден.');
        return;
      }
      await ctx.reply([
        `Заказ №${order.orderNumber}`,
        `Бизнес: ${order.businessName}`,
        `Тариф: ${order.tariffName}`,
        `Стоимость: ${order.price} ${order.currency.trim()}`,
        `Рекламодатель: ${customerLabel(order.firstName, order.username)}`,
        `Фактическая дата: ${order.publicationAt ? displayPublicationDate(order.publicationAt) : 'не назначена'}`,
        publicationDatesStatusText(order.publicationDates, order.publicationStatuses),
        'Статус: ожидает решения',
      ].join('\n'), {
        reply_markup: new InlineKeyboard()
          .text('Подтвердить заказ', `admin:order:confirmed:${order.id}`)
          .text('Отклонить заказ', `admin:order:rejected:${order.id}`).row()
          .text('Написать рекламодателю', `admin:message_order:${order.id}`),
      });
      return;
    }
    if (parts[1] === 'schedule') {
      if (parts[2] === 'noop') return;
      if (parts[2] === 'calendar' && parts[3]) {
        const month = parseCalendarMonth(parts[3]);
        if (!month) return;
        await ctx.editMessageReplyMarkup({
          reply_markup: calendarKeyboard(month.year, month.month, 'admin:schedule'),
        });
        return;
      }
      if (parts[2] === 'calendar_back') {
        await service.cancel(adminId);
        await ctx.editMessageText('Назначение даты публикации отменено.');
        return;
      }
      if (parts[2] === 'pickdate' && parts[3]) {
        const result = await service.answer(adminId, parts[3]);
        if (!result || result.kind === 'invalid') {
          await ctx.reply(result?.kind === 'invalid' ? result.text : 'Сначала выберите заказ.');
          return;
        }
        if (result.kind === 'done') {
          if (result.customerNotification) {
            await ctx.api.sendMessage(
              result.customerNotification.telegramId,
              fromAdmin(`Для заказа №${result.customerNotification.orderNumber} назначена дата публикации: ${displayPublicationDate(result.customerNotification.publicationAt)}. Статус и детали доступны в разделе «Текущие заказы».`),
            );
          }
          await ctx.editMessageText(result.text);
        }
        return;
      }
    }
    if (parts[1] === 'orders') {
      const oldMessageIds = adminOrderListMessageIds.get(adminId) ?? [];
      await Promise.allSettled(oldMessageIds.map((messageId) => ctx.api.deleteMessage(adminId, messageId)));
      const messageIds = await showOrders(ctx, repository, parts[2] === 'all' ? null : parts[2] ?? null);
      adminOrderListMessageIds.set(adminId, messageIds);
      return;
    }
    if (parts[1] === 'materials' && parts[2] === 'list') {
      await showMaterialSubmissions(ctx, repository);
      return;
    }
    if (parts[1] === 'materials' && parts[2] === 'status'
      && (parts[3] === 'submitted' || parts[3] === 'approved')) {
      await showMaterialSubmissionsByStatus(ctx, repository, parts[3]);
      return;
    }
    if (parts[1] === 'materials' && parts[2] === 'approve' && parts[3]) {
      const item = await repository.getMaterialSubmission(parts[3]);
      if (!item || !(await repository.setMaterialStatus(item.orderId, 'approved'))) {
        await ctx.reply('Материалы уже обработаны или заказ не найден.');
        return;
      }
      const dateText = publicationDatesStatusText(item.publicationDates, item.publicationStatuses);
      await Promise.allSettled([
        ctx.api.sendMessage(item.telegramId, fromAdmin(`Материалы заказа №${item.orderNumber} согласованы. ${dateText}`)),
        ctx.reply(`Материалы заказа №${item.orderNumber} согласованы.`, {
          reply_markup: new InlineKeyboard()
            .text('Изменить даты публикаций', `admin:md:open:${item.orderId}`)
            .text('Отметить публикацию', `admin:order:completed:${item.orderId}`),
        }),
      ]);
      return;
    }
    if (parts[1] === 'materials' && parts[2] === 'corrections' && parts[3]) {
      const item = await repository.getMaterialSubmission(parts[3]);
      if (!item) {
        await ctx.reply('Материалы уже обработаны или заказ не найден.');
        return;
      }
      const context = `Ответ по заказу №${item.orderNumber} «${item.tariffName}» для бизнеса «${item.businessName}».`;
      await ctx.reply(await service.startMessage(
        adminId,
        item.telegramId,
        undefined,
        item.orderId,
        undefined,
        context,
        customerLabel(item.firstName, item.username, item.businessName),
      ), {
        reply_markup: adminFlowKeyboard,
      });
      return;
    }
    if (parts[1] === 'materials' && parts[2] === 'open' && parts[3]) {
      await sendMaterialSubmissionToAdmin(ctx, repository, parts[3]);
      return;
    }
    if (parts[1] === 'payment' && parts[3]) {
      const approved = parts[2] === 'approve';
      const reviewed = await repository.reviewPayment(parts[3], adminId, approved);
      if (!reviewed) {
        await ctx.reply('Платёж уже обработан или не найден.');
        return;
      }
      const referralBonusNotification = reviewed.referralBonus
        ? ctx.api.sendMessage(
          reviewed.referralBonus.referrerTelegramId,
          `🎁 Вам начислен реферальный бонус: ${reviewed.referralBonus.amount} ${reviewed.referralBonus.currency}.${reviewed.referralBonus.expiresAt ? ` Используйте до ${new Date(reviewed.referralBonus.expiresAt).toLocaleDateString('ru-RU')}.` : ''}`,
        )
        : Promise.resolve();
      const statusMessage = fromAdmin(approved
        ? `Оплата заказа №${reviewed.orderNumber} подтверждена.`
        : `Оплата заказа №${reviewed.orderNumber} не подтверждена. Проверьте платёжные данные и отправьте сообщение об оплате повторно.`);
      const customerKeyboard = new InlineKeyboard();
      if (!approved) customerKeyboard.text('Выбрать способ оплаты повторно', `pay:methods:${reviewed.orderId}`);
      let consentPromptSent = false;
      if (approved) {
        const preferences = await startService.getPreferences(reviewed.telegramId);
        const marketingEnabled = preferences.monthlyPromotions
          || preferences.applicationReminders
          || preferences.repeatPlacementMessages;
        if (!marketingEnabled || !preferences.feedbackRequests) {
          await startService.setPendingConsentOrder(reviewed.telegramId, reviewed.orderId);
          try {
            await ctx.api.sendMessage(
              reviewed.telegramId,
              `Оплата заказа №${reviewed.orderNumber} подтверждена.\n\n${notificationConsentText(preferences)}`,
              { reply_markup: notificationConsentKeyboard(preferences) },
            );
            consentPromptSent = true;
          } catch (error) {
            await startService.clearPendingConsentOrder(reviewed.telegramId);
            console.error(`Could not ask notification consent for order ${reviewed.orderNumber}:`, error);
          }
        }
        const materialState = await materialService.startAfterPayment(reviewed.orderId);
        if (materialState?.status === 'collecting') {
          const [customerDelivery] = await Promise.allSettled([
            (async () => {
              if (!consentPromptSent) {
                await ctx.api.sendMessage(reviewed.telegramId, statusMessage, { reply_markup: { remove_keyboard: true } });
              }
              await sendMaterialPromptWithReuseOffer(ctx.api, reviewed.telegramId, materialState, materialService);
            })(),
            referralBonusNotification,
          ]);
          const materialsSent = customerDelivery?.status === 'fulfilled';
          if (customerDelivery?.status === 'rejected') {
            console.error(`Could not start material collection for order ${reviewed.orderNumber}:`, customerDelivery.reason);
          }
          await ctx.reply(
            `Оплата заказа №${reviewed.orderNumber} подтверждена. ${customerLabel(reviewed.firstName, reviewed.username, reviewed.businessName)}: ${materialsSent ? 'запрос материалов отправлен.' : 'не удалось отправить запрос материалов; проверьте доступность пользователя в Telegram.'}`,
          );
          return;
        }
      }
      await Promise.allSettled([
        ctx.api.sendMessage(reviewed.telegramId, statusMessage,
          customerKeyboard.inline_keyboard.length > 0 ? { reply_markup: customerKeyboard } : {}),
        referralBonusNotification,
        ctx.reply(`Оплата заказа №${reviewed.orderNumber} ${approved ? 'подтверждена' : 'отклонена'}. Уведомление отправлено: ${customerLabel(reviewed.firstName, reviewed.username, reviewed.businessName)}.`),
      ]);
      return;
    }
    if (parts[1] === 'order' && parts[2] === 'schedule' && parts[3]) {
      await showScheduleCalendar(ctx, service, adminId, parts[3]);
      return;
    }
    if (parts[1] === 'order' && parts[3]) {
      const status = parts[2];
      if (status === 'completed') {
        await showPublicationSelector(ctx, repository, parts[3]);
        return;
      }
      if (status === 'confirmed' || status === 'rejected' || status === 'cancelled' || status === 'completed') {
        const changed = await repository.changeOrderStatus(parts[3], adminId, status);
        if (!changed) {
          const conflict = 'Заказ уже изменён или обработан. Эта кнопка устарела; обновите список заказов.';
          await ctx.answerCallbackQuery({ text: conflict, show_alert: true });
          try {
            await ctx.editMessageReplyMarkup({ reply_markup: new InlineKeyboard() });
          } catch {
            // The callback message may have been removed or its keyboard already changed.
          }
          return;
        }
        await ctx.answerCallbackQuery({ text: 'Статус заказа обновлён.' });
        try {
          await ctx.editMessageReplyMarkup({ reply_markup: new InlineKeyboard() });
        } catch {
          // The callback message may have been removed or its keyboard already changed.
        }
        if (status === 'completed') await repository.setMaterialStatus(changed.id, 'approved');
        if (status === 'rejected') await repository.setMaterialStatus(changed.id, 'rejected');
        const statusLabels: Record<typeof status, string> = {
          confirmed: 'подтверждён',
          rejected: 'отклонён',
          cancelled: 'отменён',
          completed: 'отмечен как опубликованный',
        };
        const text = `Заказ №${changed.orderNumber} ${statusLabels[status]}.`;
        let customerMessage = fromAdmin(text);
        let customerKeyboard = new InlineKeyboard();
        if (status === 'confirmed') {
          customerMessage = fromAdmin(`${text}\n\nВыберите способ оплаты, чтобы получить инструкцию.`);
          if (config.paymentMethods.length > 0) {
            customerKeyboard = paymentMethodsKeyboard(changed.id, config.paymentMethods);
            await repository.schedulePaymentCheckoutReminder(changed.id, changed.telegramId);
          }
          if (config.paymentMethods.length === 0) {
            customerMessage = fromAdmin(`${text}\n\nСпособ оплаты пока не настроен. Напишите администратору через «Задать вопрос».`);
          }
        }
        if (status === 'confirmed' && config.paymentMethods.length === 0) customerKeyboard.text('Задать вопрос', 'open_question_topics');
        if (status === 'rejected') customerKeyboard.text('Задать вопрос', 'open_question_topics');
        await Promise.allSettled([
          ctx.api.sendMessage(changed.telegramId, customerMessage,
            customerKeyboard.inline_keyboard.length > 0 ? { reply_markup: customerKeyboard } : {}),
          ctx.reply(text, { reply_markup: adminMenuKeyboard() }),
        ]);
      }
      return;
    }
    if (parts[1] === 'message_order' && parts[2]) {
      const order = (await repository.listOrders()).find((item) => item.id === parts[2]);
      if (!order) {
        await ctx.reply('Заказ не найден.');
        return;
      }
      const context = `Ответ по заказу №${order.orderNumber} «${order.tariffName}» для бизнеса «${order.businessName}».`;
      await ctx.reply(await service.startMessage(
        adminId,
        order.telegramId,
        undefined,
        undefined,
        undefined,
        context,
        customerLabel(order.firstName, order.username, order.businessName),
      ), { reply_markup: adminFlowKeyboard });
      return;
    }
    if (parts[1] === 'message_lead' && parts[2]) {
      const lead = (await repository.listBusinessLeads()).find((item) => item.telegramId === parts[2]);
      const context = lead
        ? `Сообщение по вашей заявке рекламодателя для бизнеса «${lead.businessName}».`
        : 'Сообщение администратора по вашей заявке рекламодателя.';
      await ctx.reply(await service.startMessage(
        adminId,
        parts[2],
        undefined,
        undefined,
        undefined,
        context,
        lead ? customerLabel(lead.firstName, lead.username, lead.businessName) : undefined,
      ), { reply_markup: adminFlowKeyboard });
      return;
    }
    if (parts[1] === 'message' && parts[2]) {
      await ctx.reply(await service.startMessage(adminId, parts[2], parts[3]), { reply_markup: adminFlowKeyboard });
      return;
    }

    await next();
  });

}
