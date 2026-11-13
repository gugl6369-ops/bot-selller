import { Api, InlineKeyboard, Keyboard, type Context } from 'grammy';
import { config } from '../../../config/env.ts';
import type { AdminRepository } from '../../../db/repositories/admin-repository.ts';
import { AdminService } from '../../../services/admin-service.ts';
import type { StartService } from '../../../services/start-service.ts';
import { calendarKeyboard, currentIsoDate } from '../../keyboards/calendar.ts';
import type { AdminFeedback, AdminInquiry } from '../../../types/admin.ts';
import { isDataDeletionInquiry } from '../../../services/inquiry-topics.ts';
import { customerLabel, dayCountLabel, minuteTimestamp } from '../../../services/admin-display.ts';
import { publicationDatesLabel, publicationDatesStatusText } from '../../../services/publication-dates.ts';

export function adminMenuKeyboard(): Keyboard {
  return new Keyboard()
    .text('Заказы').row()
    .text('Материалы').text('Платежи').row()
    .text('Центр событий').row()
    .text('Инструменты')
    .resized()
    .persistent();
}

export function adminToolsKeyboard(): Keyboard {
  return new Keyboard()
    .text('Тарифы').row()
    .text('Заявки').text('Вопросы').row()
    .text('Рассылка').text('Рефералы').row()
    .text('Отзывы').text('Удаление данных').row()
    .text('Статистика')
    .row().text('Назад')
    .resized()
    .persistent();
}

export const adminFlowKeyboard = new Keyboard()
  .text('Назад')
  .resized()
  .persistent();

export const broadcastFlowKeyboard = new Keyboard()
  .text('Отменить')
  .resized()
  .persistent();

export function fromAdmin(message: string): string {
  return `✉️ Сообщение от администратора:\n\n${message}`;
}

export function displayPublicationDate(isoDateTime: string): string {
  const date = isoDateTime.slice(0, 10);
  const [year, month, day] = date.split('-');
  return `${day}.${month}.${year}`;
}

export function publicationNotificationText(publication: {
  orderNumber: string;
  businessName: string;
  publicationLink: string | null;
  publicationDate: string;
  publicationNumber: number;
  publicationCount: number;
  remainingPublications: number;
  allPublished: boolean;
  feedbackDelayDays: number;
}): string {
  const link = publication.publicationLink ? `\nСсылка: ${publication.publicationLink}` : '';
  if (!publication.allPublished) {
    const date = publication.publicationDate ? ` · дата ${displayPublicationDate(publication.publicationDate)}` : '';
    return `Опубликована публикация ${publication.publicationNumber} из ${publication.publicationCount} рекламы «${publication.businessName}» по заказу №${publication.orderNumber}${date}.${link}\nОсталось публикаций: ${publication.remainingPublications}.`;
  }
  return `Все ${publication.publicationCount} публикации рекламы «${publication.businessName}» по заказу №${publication.orderNumber} опубликованы.${link}\n\nЧерез ${dayCountLabel(publication.feedbackDelayDays)} мы спросим вас о результате размещения.`;
}

export async function showScheduleCalendar(
  ctx: Context,
  service: AdminService,
  adminId: string,
  orderId: string,
): Promise<void> {
  const [year, month] = currentIsoDate().split('-').map(Number);
  const prompt = await service.startScheduleOrder(adminId, orderId);
  await ctx.reply(prompt, { reply_markup: calendarKeyboard(year, month, 'admin:schedule') });
}

export async function isAdmin(ctx: Context, startService: StartService): Promise<boolean> {
  const sender = ctx.from;
  return sender ? startService.isAdmin(String(sender.id)) : false;
}

export async function showAdminMenu(ctx: Context, _repository: AdminRepository): Promise<void> {
  await ctx.reply('Панель администратора. Выберите раздел:', {
    reply_markup: adminMenuKeyboard(),
  });
}

const materialListMessageIdsByAdmin = new Map<string, number[]>();

function materialStatusKeyboard(counts: { submitted: number; approved: number }): InlineKeyboard {
  return new InlineKeyboard()
    .text(`🆕 Новые на проверке (${counts.submitted})`, 'admin:materials:status:submitted').row()
    .text(`✅ Согласованы — ждут полной публикации (${counts.approved})`, 'admin:materials:status:approved');
}

async function clearMaterialListMessages(ctx: Context, adminId: string): Promise<void> {
  const messageIds = materialListMessageIdsByAdmin.get(adminId) ?? [];
  await Promise.allSettled(messageIds.map((messageId) => ctx.api.deleteMessage(adminId, messageId)));
  materialListMessageIdsByAdmin.delete(adminId);
}

export async function showTariffs(ctx: Context, repository: AdminRepository): Promise<void> {
  const tariffs = await repository.listTariffs();
  const text = tariffs.length > 0
    ? `Управление тарифами (${tariffs.length})\n\n${tariffs.map((tariff) => {
      const details = [tariff.inclusions, tariff.placementDuration, tariff.description]
        .map((value) => value.trim())
        .filter(Boolean)
        .join(' · ');
      const price = Number(tariff.price).toLocaleString('ru-RU');
      return `${tariff.isActive ? '🟢' : '⚪'} ${tariff.name} — ${price} ${tariff.currency.trim()}${details ? `\n${details}` : ''}`;
    }).join('\n\n')}`
    : 'Управление тарифами\n\nТарифов пока нет.';
  const keyboard = new InlineKeyboard();
  for (const tariff of tariffs) {
    const label = tariff.name.length > 32 ? `${tariff.name.slice(0, 31)}…` : tariff.name;
    keyboard
      .text(`✏️ ${label}`, `admin:tariff:fields:${tariff.id}`)
      .text(tariff.isActive ? 'Отключить' : 'Включить', `admin:tariff:toggle:${tariff.id}`)
      .text('Удалить', `admin:tariff:delete:${tariff.id}`)
      .row();
  }
  keyboard.text('Добавить тариф', 'admin:tariff:add');
  await ctx.reply(text, { reply_markup: keyboard });
}

export function leadText(lead: Awaited<ReturnType<AdminRepository['listBusinessLeads']>>[number]): string {
  return [
    `Заявка: ${lead.businessName}`,
    `Сфера: ${lead.industry ?? 'не указана'}`,
    `Регион: ${lead.region ?? 'не указан'}`,
    `Ссылка: ${lead.websiteUrl ?? 'не указана'}`,
    `Контакт: ${lead.contactValue ?? 'не указан'}`,
    `План размещения: ${lead.requestedPlacement ?? 'не указан'}`,
    `Пользователь: ${customerLabel(lead.firstName, lead.username)}`,
  ].join('\n');
}

export async function showBusinessLeads(
  ctx: Context,
  repository: AdminRepository,
  days: number | null = null,
  search: string | null = null,
): Promise<void> {
  const leads = await repository.listBusinessLeads(days, search);
  if (leads.length === 0) {
    await ctx.reply('Заявок по этому фильтру нет.');
    return;
  }

  for (const lead of leads) {
    await ctx.reply(leadText(lead), {
      reply_markup: new InlineKeyboard().text('Написать рекламодателю', `admin:message_lead:${lead.telegramId}`),
    });
  }
}

export async function showBusinessLeadMenu(ctx: Context, repository: AdminRepository): Promise<void> {
  const count = await repository.countBusinessLeads();
  await ctx.reply(`Заявок: ${count}.`, {
    reply_markup: new InlineKeyboard()
      .text('Все заявки', 'admin:leads:all')
      .text('Поиск', 'admin:leads:search'),
  });
}

async function sendInquiryCard(ctx: Context, inquiry: AdminInquiry): Promise<void> {
  await ctx.reply([
    `Вопрос: ${inquiry.topic}`,
    `От: ${customerLabel(inquiry.firstName, inquiry.username, inquiry.businessName)}`,
    `Источник: ${inquiry.source}`,
    inquiry.message,
  ].join('\n'), {
    reply_markup: new InlineKeyboard()
      .text('Ответить', `admin:inquiry_reply:${inquiry.id}`)
      .text(isDataDeletionInquiry(inquiry.topic) ? 'Удалить данные' : 'Удалить', `admin:inquiry_delete:${inquiry.id}`),
  });
}

export async function showInquiries(ctx: Context, repository: AdminRepository): Promise<void> {
  const inquiries = await repository.listInquiries();
  if (inquiries.length === 0) {
    await ctx.reply('Вопросов пока нет.');
    return;
  }

  const deletionRequests = inquiries.filter((inquiry) => isDataDeletionInquiry(inquiry.topic));
  const questions = inquiries.filter((inquiry) => !isDataDeletionInquiry(inquiry.topic));
  if (deletionRequests.length > 0) {
    await ctx.reply(`🗑 Запросы на удаление данных: ${deletionRequests.length}.`);
    for (const inquiry of deletionRequests) await sendInquiryCard(ctx, inquiry);
  }
  for (const inquiry of questions) await sendInquiryCard(ctx, inquiry);
}

export async function showFeedbackMenu(ctx: Context, repository: AdminRepository): Promise<void> {
  const counts = await repository.getFeedbackCounts();
  await ctx.reply(`Отзывы: ${counts.total} · положительные ${counts.positive} · хотят обсудить ${counts.discussions}.`, {
    reply_markup: new InlineKeyboard()
      .text(`👍 Положительные (${counts.positive})`, 'admin:feedback:list:positive').row()
      .text(`💬 Обсуждения (${counts.discussions})`, 'admin:feedback:list:discussions').row()
      .text(`Все отзывы (${counts.total})`, 'admin:feedback:list:all').row()
      .text('Назад', 'admin:menu:back'),
  });
}

function feedbackCardText(feedback: AdminFeedback): string {
  const response = feedback.response === 'good'
    ? '👍 Положительная оценка'
    : feedback.response === 'discuss'
      ? '💬 Хочет обсудить итог'
      : '🔁 Хочет повторить рекламу';
  return [
    `${response} · заказ №${feedback.orderNumber}`,
    `Бизнес: ${feedback.businessName} · тариф: ${feedback.tariffName}`,
    `Пользователь: ${customerLabel(feedback.firstName, feedback.username)}`,
    ...(feedback.reviewText ? [`Отзыв: ${feedback.reviewText}`] : []),
    `Обсуждение: ${feedback.status === 'open' ? 'открыто' : 'закрыто'}`,
  ].join('\n');
}

export async function showFeedbackList(
  ctx: Context,
  repository: AdminRepository,
  filter: 'all' | 'positive' | 'discussions',
): Promise<void> {
  const feedback = await repository.listFeedback(filter);
  if (feedback.length === 0) {
    await ctx.reply('В этом списке пока нет отзывов.', {
      reply_markup: new InlineKeyboard().text('К отзывам', 'admin:feedback:menu'),
    });
    return;
  }
  for (const item of feedback) {
    await ctx.reply(feedbackCardText(item), {
      reply_markup: new InlineKeyboard().text('Открыть отзыв и переписку', `admin:feedback:open:${item.orderId}`),
    });
  }
  await ctx.reply('Фильтр отзывов:', {
    reply_markup: new InlineKeyboard().text('К отзывам', 'admin:feedback:menu'),
  });
}

export async function showFeedbackThread(ctx: Context, repository: AdminRepository, orderId: string): Promise<void> {
  const feedback = await repository.getFeedback(orderId);
  if (!feedback) {
    await ctx.reply('Отзыв не найден. Обновите список отзывов.');
    return;
  }
  const messages = await repository.listFeedbackMessages(orderId);
  const thread = messages.length > 0
    ? messages.slice(-8).map((item) => `${item.senderType === 'admin' ? 'Администратор' : 'Пользователь'}: ${item.message.length > 400 ? `${item.message.slice(0, 399)}…` : item.message}`).join('\n\n')
    : 'Сообщений в обсуждении пока нет.';
  const text = `${feedbackCardText(feedback)}\n\nПереписка:\n${thread}`;
  const keyboard = new InlineKeyboard();
  if (feedback.response === 'discuss' || messages.length > 0) {
    keyboard.text('Ответить пользователю', `admin:feedback:reply:${orderId}`).row();
  }
  keyboard.text(feedback.status === 'open' ? 'Закрыть обсуждение' : 'Открыть обсуждение', `admin:feedback:status:${orderId}:${feedback.status === 'open' ? 'c' : 'o'}`)
    .row().text('К отзывам', 'admin:feedback:menu');
  await ctx.reply(text, { reply_markup: keyboard });
}

export async function showDataDeletionRequests(ctx: Context, repository: AdminRepository): Promise<void> {
  const requests = await repository.listDataDeletionRequests();
  if (requests.length === 0) {
    await ctx.reply('Запросов на удаление данных нет.');
    return;
  }

  await ctx.reply(`🗑 Запросы на удаление данных: ${requests.length}.`);
  for (const inquiry of requests) await sendInquiryCard(ctx, inquiry);
}

export async function showOrders(
  ctx: Context,
  repository: AdminRepository,
  status: string | null = null,
): Promise<number[]> {
  const orders = await repository.listOrders(status);
  if (orders.length === 0) {
    const message = await ctx.reply('Заказов по этому статусу нет.');
    return [message.message_id];
  }

  const messageIds: number[] = [];
  for (const order of orders) {
    const keyboard = new InlineKeyboard();
    if (order.status === 'pending_confirmation') {
      keyboard.text('Подтвердить', `admin:order:confirmed:${order.id}`)
        .text('Отклонить', `admin:order:rejected:${order.id}`).row();
    }
    if (order.status === 'confirmed') {
      keyboard.text('Изменить даты', `admin:md:open:${order.id}`)
        .text('Отметить публикацию', `admin:order:completed:${order.id}`).row();
    }
    keyboard.text('Написать рекламодателю', `admin:message_order:${order.id}`);
    const message = await ctx.reply([
      `Заказ №${order.orderNumber}: ${order.businessName}`,
      `Формат: ${order.tariffName}`,
      `Стоимость: ${order.price} ${order.currency.trim()}`,
      `Статус: ${({
        pending_confirmation: 'Ожидает подтверждения',
        confirmed: 'Подтверждён',
        rejected: 'Отклонён',
        cancelled: 'Отменён',
        completed: 'Опубликован',
      } as Record<string, string>)[order.status] ?? order.status}`,
      publicationDatesStatusText(order.publicationDates, order.publicationStatuses),
      ...(order.reusedMaterialsFromOrderNumber
        ? [`Материалы повторно использованы из заказа №${order.reusedMaterialsFromOrderNumber}`]
        : []),
      `Рекламодатель: ${customerLabel(order.firstName, order.username)}`,
    ].join('\n'), { reply_markup: keyboard });
    messageIds.push(message.message_id);
  }
  return messageIds;
}

export async function showPublicationSelector(
  ctx: Context,
  repository: AdminRepository,
  orderId: string,
  editCurrentMessage = false,
): Promise<void> {
  const order = await repository.getOrderDateInfo(orderId);
  if (!order) {
    if (editCurrentMessage) await ctx.editMessageText('Заказ не найден. Обновите список заказов.');
    else await ctx.reply('Заказ не найден. Обновите список заказов.');
    return;
  }
  const pending = order.publicationDates
    .map((date, index) => ({ date, index }))
    .filter(({ index }) => order.publicationStatuses[index] !== 'published');
  if (pending.length === 0) {
    const text = `Все публикации заказа №${order.orderNumber} уже отмечены как опубликованные.\n${publicationDatesStatusText(order.publicationDates, order.publicationStatuses)}`;
    if (editCurrentMessage) await ctx.editMessageText(text);
    else await ctx.reply(text);
    return;
  }
  const keyboard = new InlineKeyboard();
  for (const { date, index } of pending) {
    const dateStatus = order.publicationDateStatuses[index] ?? (date ? 'confirmed' : 'awaiting_admin');
    if (date && dateStatus === 'confirmed') {
      keyboard.text(`Отметить №${index + 1} · ${displayPublicationDate(date)}`, `admin:pubsel:${order.id}:${index}`)
        .text('Изменить дату', `admin:md:edit:${order.id}:${index}`).row();
    } else if (date && dateStatus === 'awaiting_user') {
      keyboard.text(`⏳ Ждёт согласия · №${index + 1}`, `admin:md:edit:${order.id}:${index}`).row();
    } else {
      keyboard.text(`Назначить дату · №${index + 1}`, `admin:md:edit:${order.id}:${index}`).row();
    }
  }
  const text = `Выберите публикацию заказа №${order.orderNumber}. Отметить её можно после назначения даты и согласования пользователем.\n${publicationDatesStatusText(order.publicationDates, order.publicationStatuses)}`;
  if (editCurrentMessage) await ctx.editMessageText(text, { reply_markup: keyboard });
  else await ctx.reply(text, { reply_markup: keyboard });
}

export async function showMaterialSubmissions(ctx: Context, repository: AdminRepository): Promise<void> {
  const adminId = ctx.from ? String(ctx.from.id) : undefined;
  if (adminId) await clearMaterialListMessages(ctx, adminId);
  const counts = await repository.getMaterialStatusCounts();
  await ctx.reply('Материалы по статусам. Выберите нужный список:', {
    reply_markup: materialStatusKeyboard(counts),
  });
}

export async function showMaterialSubmissionsByStatus(
  ctx: Context,
  repository: AdminRepository,
  status: 'submitted' | 'approved',
): Promise<void> {
  const adminId = ctx.from ? String(ctx.from.id) : undefined;
  if (!adminId) return;
  await clearMaterialListMessages(ctx, adminId);
  const [counts, submissions] = await Promise.all([
    repository.getMaterialStatusCounts(),
    repository.listMaterialSubmissionsByStatus(status),
  ]);
  const heading = status === 'submitted'
    ? `🆕 Новые материалы на проверке: ${counts.submitted}`
    : `✅ Согласованные материалы, ожидающие полной публикации: ${counts.approved}`;
  try {
    await ctx.editMessageText(heading, { reply_markup: materialStatusKeyboard(counts) });
  } catch (error) {
    const description = error instanceof Error ? error.message : String(error);
    if (!/message is not modified/i.test(description)) throw error;
  }
  const messageIds: number[] = [];
  if (submissions.length === 0) {
    const message = await ctx.reply('В этой категории материалов пока нет.');
    messageIds.push(message.message_id);
    materialListMessageIdsByAdmin.set(adminId, messageIds);
    return;
  }

  for (const item of submissions) {
    const message = await ctx.reply([
      `${item.status === 'approved' ? '✅ Согласованные материалы' : '🕘 Материалы на проверке'} · заказ №${item.orderNumber}`,
      `Бизнес: ${item.businessName}`,
      `Тариф: ${item.tariffName}`,
      `Рекламодатель: ${customerLabel(item.firstName, item.username)}`,
      publicationDatesStatusText(item.publicationDates, item.publicationStatuses),
      `Файлов: ${item.media.length}`,
      `Текст: ${item.adText.slice(0, 180)}${item.adText.length > 180 ? '…' : ''}`,
    ].join('\n'), {
      reply_markup: new InlineKeyboard().text(
        item.status === 'approved' ? 'Просмотреть материалы' : 'Открыть пакет материалов',
        `admin:materials:open:${item.orderId}`,
      ),
    });
    messageIds.push(message.message_id);
  }
  materialListMessageIdsByAdmin.set(adminId, messageIds);
}

export async function sendMaterialSubmissionToAdmin(
  ctx: Context,
  repository: AdminRepository,
  orderId: string,
): Promise<void> {
  const item = await repository.getMaterialSubmission(orderId, true);
  if (!item) {
    await ctx.reply('Пакет материалов не найден или ещё не отправлен.');
    return;
  }
  const details = [
    `Материалы к заказу №${item.orderNumber}`,
    `Бизнес: ${item.businessName}`,
    `Тариф: ${item.tariffName}`,
    `Рекламодатель: ${customerLabel(item.firstName, item.username)}`,
    publicationDatesStatusText(item.publicationDates, item.publicationStatuses),
    `Отправлено: ${minuteTimestamp(item.submittedAt)}`,
    '',
    `Текст рекламы:\n${item.adText}`,
    '',
    `Ссылка, адрес или контакт: ${item.destination}`,
    `Дополнительные пожелания: ${item.wishes || 'нет'}`,
  ].join('\n');
  const reviewKeyboard = item.status === 'approved'
    ? new InlineKeyboard()
      .text('Изменить даты публикаций', `admin:md:open:${item.orderId}`)
      .text('Отметить публикацию', `admin:order:completed:${item.orderId}`)
    : new InlineKeyboard()
      .text('✅ Согласовать', `admin:materials:approve:${item.orderId}`).row()
      .text('Запросить исправления', `admin:materials:corrections:${item.orderId}`)
      .text('Изменить даты публикаций', `admin:md:open:${item.orderId}`)
      .row()
      .text('Отклонить', `admin:order:rejected:${item.orderId}`)
      .text('Опубликован', `admin:order:completed:${item.orderId}`);
  const fullDetails = `${item.status === 'approved' ? '✅ Материалы уже согласованы.' : 'Статус: ожидают проверки.'}\n\n${details}`;
  if (item.media.length === 0) {
    await ctx.reply(fullDetails, { reply_markup: reviewKeyboard });
    return;
  }

  const chatId = ctx.chat?.id;
  if (!chatId) return;

  if (item.media.length === 1 && fullDetails.length <= 1024) {
    const [media] = item.media;
    try {
      if (media.kind === 'photo') {
        await ctx.api.sendPhoto(chatId, media.fileId, { caption: fullDetails, reply_markup: reviewKeyboard });
      } else {
        await ctx.api.sendVideo(chatId, media.fileId, { caption: fullDetails, reply_markup: reviewKeyboard });
      }
    } catch (error) {
      console.error(`Failed to show media for order ${item.orderNumber}:`, error);
      await ctx.reply(`${fullDetails}\n\nНе удалось загрузить фото или видео. Повторите открытие пакета позже.`, {
        reply_markup: reviewKeyboard,
      });
    }
    return;
  }

  let mediaFailure = false;
  try {
    if (item.media.length === 1) {
      const [media] = item.media;
      if (media.kind === 'photo') {
        await ctx.api.sendPhoto(chatId, media.fileId);
      } else {
        await ctx.api.sendVideo(chatId, media.fileId);
      }
    } else {
      await ctx.api.sendMediaGroup(chatId, item.media.map((media) => ({
        type: media.kind,
        media: media.fileId,
      })));
    }
  } catch (error) {
    console.error(`Failed to show media album for order ${item.orderNumber}:`, error);
    mediaFailure = true;
  }
  await ctx.reply([
    fullDetails,
    ...(mediaFailure ? ['Не удалось загрузить фото или видео. Повторите открытие пакета позже.'] : []),
  ].join('\n\n'), { reply_markup: reviewKeyboard });
}

export async function showPayments(ctx: Context, repository: AdminRepository): Promise<void> {
  const payments = await repository.listPendingPayments();
  if (payments.length === 0) {
    await ctx.reply('Ожидающих подтверждения оплат нет.');
    return;
  }

  for (const payment of payments) {
    const details = [
      `Оплата заказа №${payment.orderNumber} · сообщил ${minuteTimestamp(payment.reportedAt)}`,
      `Покупатель: ${customerLabel(payment.firstName, payment.username, payment.businessName)}`,
      publicationDatesLabel(payment.publicationDates),
      `${payment.amount} ${payment.currency.trim()} · ${payment.paymentMethod}`,
      ...(payment.proofFileId ? ['Скриншот перевода приложен.'] : []),
    ].join('\n');
    const keyboard = new InlineKeyboard()
      .text('Подтвердить оплату', `admin:payment:approve:${payment.id}`)
      .text('Отклонить', `admin:payment:reject:${payment.id}`);
    if (payment.proofFileId) {
      await ctx.replyWithPhoto(payment.proofFileId, { caption: details, reply_markup: keyboard });
    } else {
      await ctx.reply(details, { reply_markup: keyboard });
    }
  }
}

export async function showStatistics(ctx: Context, repository: AdminRepository): Promise<void> {
  const stats = await repository.getStatistics();
  const popularTariffs = await repository.getPopularTariffs();
  const number = (value: string): number => Number.parseInt(value, 10) || 0;
  const formatNumber = (value: string | number): string => Number(value).toLocaleString('ru-RU');
  const escapeHtml = (value: string): string => value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
  const bar = (value: number, maximum: number, width = 12): string => {
    const filled = maximum > 0 ? Math.max(0, Math.min(width, Math.round((value / maximum) * width))) : 0;
    return `${'▰'.repeat(filled)}${'▱'.repeat(width - filled)}`;
  };
  const approvedPayments = number(stats.confirmed_payments);
  const rejectedPayments = number(stats.rejected_payments);
  const reviewedPayments = approvedPayments + rejectedPayments;
  const approvedShare = reviewedPayments > 0 ? Math.round((approvedPayments / reviewedPayments) * 100) : 0;
  const maxTariffOrders = Math.max(0, ...popularTariffs.map((tariff) => number(tariff.orders)));
  const tariffRows = popularTariffs.length > 0
    ? popularTariffs.map((tariff, index) => {
      const orders = number(tariff.orders);
      const medal = ['🥇', '🥈', '🥉'][index] ?? `${index + 1}.`;
      const name = escapeHtml(tariff.name.length > 32 ? `${tariff.name.slice(0, 31)}…` : tariff.name);
      const label = orders === 1 ? 'заказ' : 'заказов';
      return `${medal} <b>${name}</b> · ${formatNumber(orders)} ${label}\n<code>${bar(orders, maxTariffOrders)}</code>`;
    })
    : ['Пока нет заказов — тарифы ждут первого размещения.'];

  const text = [
    '📊 <b>ПУЛЬС ПРОЕКТА</b>',
    '<i>Сводка показателей за всё время</i>',
    '━━━━━━━━━━━━━━',
    '',
    '👥 <b>АУДИТОРИЯ</b>',
    `▫️ Пользователи <b>${formatNumber(stats.users)}</b>`,
    `▫️ Бизнесы <b>${formatNumber(stats.businesses)}</b>`,
    `▫️ Вопросы <b>${formatNumber(stats.inquiries)}</b>`,
    `▫️ Переходы по рекомендациям <b>${formatNumber(stats.referral_clicks)}</b>`,
    '',
    '💳 <b>ОПЛАТЫ</b>',
    `✅ Подтверждены <b>${formatNumber(approvedPayments)}</b>`,
    `❌ Отклонены <b>${formatNumber(rejectedPayments)}</b>`,
    `<code>${bar(approvedPayments, reviewedPayments)} ${approvedShare}%</code>`,
    `<i>Доля одобрения среди ${formatNumber(reviewedPayments)} проверенных оплат</i>`,
    '',
    '📦 <b>РАЗМЕЩЕНИЯ</b>',
    `🎉 Опубликованные заказы <b>${formatNumber(stats.published_orders)}</b>`,
    `🗓 Согласованы даты публикаций <b>${formatNumber(stats.scheduled_publications)}</b>`,
    `↩️ Отменённые заказы <b>${formatNumber(stats.cancelled_orders)}</b>`,
    `🏷 Заказы со скидкой <b>${formatNumber(stats.discounted_orders)}</b>`,
    '',
    '💬 <b>ОТЗЫВЫ</b>',
    `👍 Положительные <b>${formatNumber(stats.positive_feedback)}</b>`,
    `🗣 Хотят обсудить итог <b>${formatNumber(stats.discussion_feedback)}</b>`,
    '',
    '🔁 <b>ВОЗВРАЩАЮТСЯ</b>',
    `Клиенты с повторными заказами <b>${formatNumber(stats.repeat_customers)}</b>`,
    '',
    `📣 Активных тарифов <b>${formatNumber(stats.active_tariffs)}</b>`,
    '',
    '🏆 <b>ЛИДЕРЫ ПО ЗАКАЗАМ</b>',
    '<i>Шкала показывает популярность относительно лидера</i>',
    ...tariffRows,
  ].join('\n');

  const metric = (label: string, value: string | number, color: string): string =>
    `<div style="background:#18202c;border-radius:12px;padding:12px;flex:1;min-width:130px;">`
    + `<div style="color:#aab6c5;font-size:12px;">${label}</div>`
    + `<div style="color:${color};font-size:24px;font-weight:700;margin-top:5px;">${formatNumber(value)}</div>`
    + '</div>';
  const bubbleTariffs = popularTariffs.length > 0
    ? popularTariffs.slice(0, 5).map((tariff, index) => {
      const orders = number(tariff.orders);
      const fill = maxTariffOrders > 0 ? Math.max(4, Math.round((orders / maxTariffOrders) * 100)) : 0;
      const name = escapeHtml(tariff.name.length > 35 ? `${tariff.name.slice(0, 34)}…` : tariff.name);
      const colors = ['#a78bfa', '#60a5fa', '#34d399', '#fbbf24', '#fb7185'];
      return `<div style="margin-top:12px;">`
        + `<div style="display:flex;justify-content:space-between;gap:8px;color:#e5eaf1;font-size:13px;">`
        + `<span>${index + 1}. ${name}</span><b>${formatNumber(orders)}</b></div>`
        + `<div style="height:7px;background:#303b4b;border-radius:8px;margin-top:6px;overflow:hidden;">`
        + `<div style="height:7px;width:${fill}%;background:${colors[index % colors.length]};border-radius:8px;"></div></div></div>`;
    }).join('')
    : '<div style="color:#aab6c5;font-size:13px;margin-top:12px;">Пока нет заказов — тарифы ждут первого размещения.</div>';
  const widgetHtml = `<div style="font-family:Arial,sans-serif;color:#f5f7fb;background:#101720;padding:18px;border-radius:18px;">`
    + '<div style="font-size:12px;color:#aab6c5;letter-spacing:1px;">АДМИНИСТРАТОР · СВОДКА ЗА ВСЁ ВРЕМЯ</div>'
    + '<div style="font-size:24px;font-weight:700;margin-top:5px;">📊 Пульс проекта</div>'
    + '<div style="display:flex;flex-wrap:wrap;gap:9px;margin-top:16px;">'
    + metric('Пользователи', stats.users, '#60a5fa')
    + metric('Бизнесы', stats.businesses, '#a78bfa')
    + metric('Заказы опубликованы', stats.published_orders, '#34d399')
    + metric('Активные тарифы', stats.active_tariffs, '#fbbf24')
    + '</div>'
    + '<div style="display:flex;gap:9px;margin-top:9px;">'
    + metric('Оплаты одобрены', approvedPayments, '#34d399')
    + metric('Оплаты отклонены', rejectedPayments, '#fb7185')
    + '</div>'
    + '<div style="display:flex;gap:9px;margin-top:9px;">'
    + metric('Положительные отзывы', stats.positive_feedback, '#34d399')
    + metric('Обсуждения итогов', stats.discussion_feedback, '#fbbf24')
    + '</div>'
    + `<div style="background:#18202c;border-radius:14px;padding:14px;margin-top:12px;">`
    + '<div style="font-size:15px;font-weight:700;">🏆 Популярность тарифов</div>'
    + '<div style="font-size:12px;color:#aab6c5;margin-top:3px;">Число заказов · шкала относительно лидера</div>'
    + bubbleTariffs
    + '</div>'
    + `<div style="display:flex;justify-content:space-between;gap:8px;color:#aab6c5;font-size:12px;margin-top:13px;">`
    + `<span>Повторные клиенты <b style="color:#f5f7fb;">${formatNumber(stats.repeat_customers)}</b></span>`
    + `<span>Реферальные переходы <b style="color:#f5f7fb;">${formatNumber(stats.referral_clicks)}</b></span>`
    + '</div></div>';

  const chatId = ctx.chat?.id;
  if (chatId !== undefined) {
    try {
      const betaApi = new Api(config.apiToken, { apiRoot: 'https://api.telegram.org/beta' });
      const widgetApi = betaApi.raw as unknown as {
        sendWidget(payload: {
          chat_id: number;
          html: string;
          width: number;
          height: number;
          caption: string;
        }): Promise<unknown>;
      };
      await widgetApi.sendWidget({
        chat_id: chatId,
        html: widgetHtml,
        width: 440,
        height: 0,
        caption: `📊 Пульс проекта · пользователи ${formatNumber(stats.users)} · положительные отзывы ${formatNumber(stats.positive_feedback)} · обсуждения ${formatNumber(stats.discussion_feedback)}`,
      });
      return;
    } catch (error) {
      console.warn('HTMLBubbles statistics are unavailable; falling back to an HTML message.', error);
    }
  }
  await ctx.reply(text, { parse_mode: 'HTML' });
}

export async function showReferrals(ctx: Context, repository: AdminRepository): Promise<void> {
  const referrals = await repository.getReferralOverview();
  if (referrals.length === 0) {
    await ctx.reply('Переходов и приглашённых пользователей пока нет.');
    return;
  }

  await ctx.reply(['Реферальная статистика:', ...referrals.map((row) =>
    `${customerLabel(row.firstName, row.username, row.businessName)}: переходы ${row.clicks}, приглашённые ${row.invited}, заявки ${row.applications}, оплаты ${row.paid}`,
  )].join('\n'));
}

