import { deflateSync } from 'node:zlib';
import { Api, InlineKeyboard, type Api as ApiType } from 'grammy';
import type { AdminRepository } from '../db/repositories/admin-repository.ts';
import { customerLabel, minuteTimestamp } from './admin-display.ts';
import { isDataDeletionInquiry } from './inquiry-topics.ts';
import { publicationDatesStatusText, publicationDatesText } from './publication-dates.ts';

function short(value: string, limit = 88): string {
  const compact = value.replace(/\s+/g, ' ').trim();
  return compact.length > limit ? `${compact.slice(0, limit - 1)}…` : compact;
}

function escapeHtml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
}

function createInboxKeyboard(counts: {
  leads: number;
  questions: number;
  deletions: number;
  orders: number;
  payments: number;
  materials: number;
  feedbacks: number;
}): InlineKeyboard {
  return new InlineKeyboard()
    .text('↻ Обновить', 'admin:inbox:refresh').row()
    .text(`Заявки · ${counts.leads}`, 'admin:leads:all')
    .text(`Заказы · ${counts.orders}`, 'admin:orders:pending_confirmation').row()
    .text(`Вопросы · ${counts.questions}`, 'admin:inquiries')
    .text(`Удаление · ${counts.deletions}`, 'admin:data_deletion').row()
    .text(`Оплаты · ${counts.payments}`, 'admin:payments')
    .text(`Материалы · ${counts.materials}`, 'admin:materials:list').row()
    .text(`Отзывы · ${counts.feedbacks}`, 'admin:feedback:menu');
}

function createInboxWidget(sections: { title: string; count: number; rows: string[] }[], total: number): string {
  const card = (section: { title: string; count: number; rows: string[] }): string => {
    const details = section.rows.length > 0
      ? section.rows.map((row) => `<div style="margin-top:5px;color:#d8e0ec;font-size:12px;line-height:1.35;">${escapeHtml(row)}</div>`).join('')
      : '<div style="margin-top:5px;color:#8291a4;font-size:12px;">Нет новых событий</div>';
    return `<div style="background:#182230;border-radius:12px;padding:10px;flex:1;min-width:145px;">`
      + `<div style="display:flex;justify-content:space-between;align-items:center;gap:6px;">`
      + `<span style="color:#aebdd0;font-size:12px;">${section.title}</span>`
      + `<b style="color:#f5f7fb;font-size:18px;">${section.count.toLocaleString('ru-RU')}</b></div>${details}</div>`;
  };
  const cards = sections.map(card).join('');
  return `<div style="font-family:Arial,sans-serif;background:#101720;color:#f5f7fb;padding:14px;border-radius:16px;">`
    + `<div style="font-size:11px;color:#9aabc0;letter-spacing:1px;">АДМИНИСТРАТОР</div>`
    + `<div style="display:flex;align-items:center;justify-content:space-between;margin-top:3px;">`
    + `<b style="font-size:20px;">🔔 Центр событий</b>`
    + `<span style="background:#263549;border-radius:12px;padding:4px 8px;font-size:12px;">${total.toLocaleString('ru-RU')}</span></div>`
    + `<div style="font-size:11px;color:#9aabc0;margin-top:3px;">Ожидают внимания или доступны для просмотра</div>`
    + `<div style="display:flex;flex-wrap:wrap;gap:8px;margin-top:12px;">${cards}</div>`
    + '</div>';
}

async function refreshAdminInboxNow(
  api: ApiType,
  repository: AdminRepository,
  adminTelegramId: string,
): Promise<boolean> {
  const [counts, inquiries, orders, payments, materials, leads, leadCount, feedbacks, currentMessageId] = await Promise.all([
    repository.getInboxCounts(),
    repository.listInquiries(),
    repository.listOrders('pending_confirmation'),
    repository.listPendingPayments(),
    repository.listMaterialSubmissions(),
    repository.listNewUserBusinessLeads(),
    repository.countNewUserBusinessLeads(),
    repository.listRecentFeedback(),
    repository.getInboxMessageId(adminTelegramId),
  ]);

  const deletionRequests = inquiries.filter((item) => isDataDeletionInquiry(item.topic));
  const questions = inquiries.filter((item) => !isDataDeletionInquiry(item.topic));
  const total = counts.unansweredQuestions + counts.dataDeletionRequests + counts.pendingOrders
    + counts.pendingPayments + counts.pendingMaterials + leadCount + counts.feedbacks;
  const sections = [
    {
      title: 'Заявки новых пользователей · 24 ч', count: leadCount,
      rows: leads.slice(0, 2).map((item) => `${short(item.businessName, 46)} · ${customerLabel(item.firstName, item.username)}`),
    },
    {
      title: 'Отзывы · 24 ч', count: counts.feedbacks,
      rows: feedbacks.slice(0, 2).map((item) => `${item.response === 'good' ? '👍 Положительный' : item.response === 'discuss' ? '💬 Обсуждение' : '🔁 Повтор'} · №${item.orderNumber} · ${short(item.businessName, 34)}`),
    },
    {
      title: 'Заказы', count: counts.pendingOrders,
      rows: orders.slice(0, 2).map((item) => `№${item.orderNumber} · ${short(item.businessName, 42)} · ${item.price} ${item.currency.trim()}`),
    },
    {
      title: 'Материалы · новые и повторы', count: counts.pendingMaterials,
      rows: materials.slice(0, 2).map((item) => item.status === 'approved'
        ? `✅ Согласованы · заказ №${item.orderNumber}${item.reusedFromOrderNumber ? ` · из №${item.reusedFromOrderNumber}` : ''} · ${short(item.businessName, 34)}`
        : `🆕 На проверке · заказ №${item.orderNumber} · ${short(item.businessName, 34)} · ${item.media.length} медиа`),
    },
    {
      title: 'Оплаты', count: counts.pendingPayments,
      rows: payments.slice(0, 2).map((item) => `№${item.orderNumber} · ${item.amount} ${item.currency.trim()} · ${minuteTimestamp(item.reportedAt)}`),
    },
    {
      title: 'Вопросы', count: counts.unansweredQuestions,
      rows: questions.slice(0, 2).map((item) => `${short(item.topic, 30)} · ${short(item.message, 54)}`),
    },
    {
      title: 'Удаление данных', count: counts.dataDeletionRequests,
      rows: deletionRequests.slice(0, 2).map((item) => `${short(item.businessName || item.firstName, 40)} · ${short(item.message, 48)}`),
    },
  ];
  const text = [
    `🔔 Центр событий администратора · ${total} записей`,
    `Заявки новых пользователей за 24 ч: ${leadCount}`,
    `Новые отзывы за 24 ч: ${counts.feedbacks}`,
    `Заказы ожидают решения: ${counts.pendingOrders}`,
    `Новые материалы и повторы (согласованные): ${counts.pendingMaterials}`,
    `Оплаты на проверку: ${counts.pendingPayments}`,
    `Новые вопросы: ${counts.unansweredQuestions}`,
    `Запросы на удаление данных: ${counts.dataDeletionRequests}`,
    '',
    ...sections.flatMap((section) => [
      `${section.title} (${section.count})`,
      ...(section.rows.length > 0 ? section.rows.map((row) => `• ${row}`) : ['Пока пусто']),
    ]),
  ].join('\n');
  const keyboard = createInboxKeyboard({
    leads: leadCount,
    questions: counts.unansweredQuestions,
    deletions: counts.dataDeletionRequests,
    orders: counts.pendingOrders,
    payments: counts.pendingPayments,
    materials: counts.pendingMaterials,
    feedbacks: counts.feedbacks,
  });
  const caption = `🔔 Центр событий · новые заявки за 24 ч ${leadCount} · отзывы за 24 ч ${counts.feedbacks} · заказы ${counts.pendingOrders} · новые материалы и повторы ${counts.pendingMaterials} · оплаты ${counts.pendingPayments}`;
  const widgetHtml = createInboxWidget(sections, total);

  let sentMessageId: number;
  try {
    if (Buffer.byteLength(widgetHtml, 'utf8') > 32_768 || deflateSync(widgetHtml, { level: 9 }).byteLength > 4_096) {
      throw new Error('Admin notification widget exceeds Telegram HTMLBubbles size limits.');
    }
    const betaApi = new Api(api.token, { apiRoot: 'https://api.telegram.org/beta' });
    const widgetApi = betaApi.raw as unknown as {
      sendWidget(payload: {
        chat_id: number | string;
        html: string;
        width: number;
        height: number;
        caption: string;
        reply_markup: InlineKeyboard;
      }): Promise<{ message_id: number }>;
    };
    const sent = await widgetApi.sendWidget({
      chat_id: adminTelegramId,
      html: widgetHtml,
      width: 420,
      height: 0,
      caption,
      reply_markup: keyboard,
    });
    sentMessageId = sent.message_id;
  } catch (error) {
    console.warn('HTMLBubbles admin inbox unavailable; using a compact text panel.', error);
    try {
      const sent = await api.sendMessage(adminTelegramId, text, { reply_markup: keyboard });
      sentMessageId = sent.message_id;
    } catch (sendError) {
      console.error(`Could not send admin inbox for ${adminTelegramId}:`, sendError);
      return false;
    }
  }

  try {
    await repository.saveInboxMessageId(adminTelegramId, sentMessageId);
  } catch (error) {
    try {
      await api.deleteMessage(adminTelegramId, sentMessageId);
    } catch { /* The saved inbox remains the current panel. */ }
    console.error(`Could not save admin inbox message for ${adminTelegramId}:`, error);
    return false;
  }
  if (currentMessageId !== undefined && currentMessageId !== sentMessageId) {
    try {
      await api.deleteMessage(adminTelegramId, currentMessageId);
    } catch {
      // A panel may already have been removed manually or replaced by another process.
    }
  }
  return true;
}

const inboxRefreshes = new Map<string, Promise<boolean>>();

/** Replaces one persistent widget/text panel per admin; refresh requests are serialized per admin. */
export async function refreshAdminInbox(
  api: ApiType,
  repository: AdminRepository,
  adminTelegramId: string,
): Promise<boolean> {
  const previous = inboxRefreshes.get(adminTelegramId);
  const current = (previous ? previous.catch(() => false) : Promise.resolve(false))
    .then(() => refreshAdminInboxNow(api, repository, adminTelegramId));
  inboxRefreshes.set(adminTelegramId, current);
  try {
    return await current;
  } finally {
    if (inboxRefreshes.get(adminTelegramId) === current) inboxRefreshes.delete(adminTelegramId);
  }
}
