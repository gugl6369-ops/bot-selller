import { InlineKeyboard, type Api } from 'grammy';
import type { AdminRepository } from '../db/repositories/admin-repository.ts';
import type { CreatedOrder, PaymentReport } from '../types/order.ts';
import type { OrderMaterialState } from '../types/order-material.ts';
import { customerLabel, minuteTimestamp } from './admin-display.ts';
import { publicationDatesStatusText, publicationDatesText } from './publication-dates.ts';

interface AdminEventMessage {
  text: string;
  replyMarkup?: InlineKeyboard;
  photoFileId?: string | null;
}

async function notifyAdmins(
  api: Api,
  adminIds: string[],
  message: AdminEventMessage,
): Promise<{ delivered: number; failed: number }> {
  if (adminIds.length === 0) return { delivered: 0, failed: 0 };
  const results = await Promise.allSettled(adminIds.map(async (adminId) => {
    if (message.photoFileId) {
      await api.sendPhoto(adminId, message.photoFileId, {
        caption: message.text,
        ...(message.replyMarkup ? { reply_markup: message.replyMarkup } : {}),
      });
    } else {
      await api.sendMessage(adminId, message.text, {
        ...(message.replyMarkup ? { reply_markup: message.replyMarkup } : {}),
      });
    }
  }));
  for (const result of results) {
    if (result.status === 'rejected') console.error('Could not deliver an admin event notification:', result.reason);
  }
  const delivered = results.filter((result) => result.status === 'fulfilled').length;
  return { delivered, failed: results.length - delivered };
}

export async function notifyNewOrder(
  api: Api,
  repository: AdminRepository,
  order: CreatedOrder,
): Promise<void> {
  let details: Awaited<ReturnType<AdminRepository['listOrders']>>[number] | undefined;
  try {
    details = (await repository.listOrders('pending_confirmation')).find((item) => item.id === order.id);
  } catch (error) {
    console.error(`Could not load details for new order ${order.orderNumber}:`, error);
  }
  const text = details
    ? [
      '🛒 Новый заказ — требуется подтверждение',
      `Заказ №${details.orderNumber}`,
      `Бизнес: ${details.businessName}`,
      `Тариф: ${details.tariffName}`,
      `Стоимость: ${details.price} ${details.currency.trim()}`,
      `Рекламодатель: ${customerLabel(details.firstName, details.username)}`,
      publicationDatesStatusText(details.publicationDates, details.publicationStatuses),
    ].join('\n')
    : `🛒 Новый заказ №${order.orderNumber} — требуется подтверждение. Стоимость: ${order.price} ${order.currency.trim()}.`;
  await notifyAdmins(api, order.adminTelegramIds, {
    text,
    replyMarkup: new InlineKeyboard()
      .text('Открыть заказ', `admin:orders:open:${order.id}`).row()
      .text('Подтвердить', `admin:order:confirmed:${order.id}`)
      .text('Отклонить', `admin:order:rejected:${order.id}`),
  });
}

export async function notifyPaymentReported(
  api: Api,
  repository: AdminRepository,
  payment: Extract<PaymentReport, { kind: 'created' }>,
): Promise<void> {
  let details: Awaited<ReturnType<AdminRepository['listPendingPayments']>>[number] | undefined;
  try {
    details = (await repository.listPendingPayments()).find((item) => item.orderNumber === payment.orderNumber);
  } catch (error) {
    console.error(`Could not load details for payment on order ${payment.orderNumber}:`, error);
  }
  const text = [
    '💳 Пользователь сообщил об оплате',
    `Заказ №${payment.orderNumber}`,
    `Сумма: ${payment.amount} ${payment.currency.trim()}`,
    `Способ оплаты: ${payment.paymentMethod}`,
    ...(details ? [
      `Рекламодатель: ${customerLabel(details.firstName, details.username, details.businessName)}`,
      `Даты публикаций: ${publicationDatesText(details.publicationDates).replace(/\n/g, ', ')}`,
      `Получено: ${minuteTimestamp(details.reportedAt)}`,
    ] : []),
    ...(details?.proofFileId ? ['Скриншот оплаты приложен.'] : []),
  ].join('\n');
  await notifyAdmins(api, payment.adminTelegramIds, {
    text,
    ...(details?.proofFileId ? { photoFileId: details.proofFileId } : {}),
    replyMarkup: details
      ? new InlineKeyboard()
        .text('Подтвердить оплату', `admin:payment:approve:${details.id}`)
        .text('Отклонить', `admin:payment:reject:${details.id}`)
      : new InlineKeyboard().text('Открыть оплаты', 'admin:payments'),
  });
}

export async function notifyMaterialsSubmitted(
  api: Api,
  repository: AdminRepository,
  state: OrderMaterialState,
  reusedFromOrderNumber?: string,
): Promise<{ delivered: number; failed: number }> {
  let details: Awaited<ReturnType<AdminRepository['getMaterialSubmission']>>;
  try {
    details = await repository.getMaterialSubmission(state.orderId, state.status === 'approved');
  } catch (error) {
    console.error(`Could not load details for materials on order ${state.orderNumber}:`, error);
  }
  const text = details
    ? [
      ...(state.status === 'approved'
        ? ['✅ Повторно использованы согласованные материалы']
        : ['📦 Пользователь отправил материалы — нужна проверка']),
      `Заказ №${details.orderNumber}`,
      ...(reusedFromOrderNumber ? [`Материалы из заказа №${reusedFromOrderNumber}`] : []),
      `Бизнес: ${details.businessName}`,
      `Тариф: ${details.tariffName}`,
      `Рекламодатель: ${customerLabel(details.firstName, details.username)}`,
      `Медиафайлов: ${details.media.length}`,
      `Текст рекламы: ${details.adText.slice(0, 350)}${details.adText.length > 350 ? '…' : ''}`,
      ...(state.status === 'approved' ? ['Статус: уже согласованы, повторная проверка не требуется.'] : []),
      `Отправлено: ${minuteTimestamp(details.submittedAt)}`,
    ].join('\n')
    : state.status === 'approved'
      ? `✅ В заказе №${state.orderNumber} повторно использованы согласованные материалы${reusedFromOrderNumber ? ` из заказа №${reusedFromOrderNumber}` : ''}.`
      : `📦 Пользователь отправил материалы по заказу №${state.orderNumber}. Откройте пакет для проверки.`;
  return notifyAdmins(api, state.adminTelegramIds, {
    text,
    replyMarkup: new InlineKeyboard().text('Открыть пакет материалов', `admin:materials:open:${state.orderId}`),
  });
}
