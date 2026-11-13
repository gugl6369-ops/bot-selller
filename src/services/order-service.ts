import {
  OrderRepository,
} from '../db/repositories/order-repository.ts';
import type { CreatedOrder, OrderDraftSummary, PaymentProofRequest, PaymentProofStart, PaymentReport, UserOrderHistoryItem } from '../types/order.ts';

export class OrderService {
  private readonly orders: OrderRepository;

  constructor(orders: OrderRepository) {
    this.orders = orders;
  }

  hasSubmittedOrder(telegramId: string): Promise<boolean> {
    return this.orders.hasSubmittedOrder(telegramId);
  }

  begin(telegramId: string, tariffId: string): Promise<boolean> {
    return this.orders.createDraft(telegramId, tariffId);
  }

  summary(telegramId: string): Promise<OrderDraftSummary | undefined> {
    return this.orders.getDraft(telegramId);
  }

  activeOrders(telegramId: string): Promise<UserOrderHistoryItem[]> {
    return this.orders.listUserOrders(telegramId, 'active');
  }

  orderHistory(telegramId: string): Promise<UserOrderHistoryItem[]> {
    return this.orders.listUserOrders(telegramId, 'history');
  }

  dueFeedback() {
    return this.orders.claimDueFeedback();
  }

  markFeedbackSent(orderId: string): Promise<void> {
    return this.orders.markFeedbackSent(orderId);
  }

  schedulePaymentCheckoutReminder(orderId: string, telegramId: string): Promise<boolean> {
    return this.orders.schedulePaymentCheckoutReminder(orderId, telegramId);
  }

  duePaymentCheckoutReminders() {
    return this.orders.claimDuePaymentCheckoutReminders();
  }

  markPaymentCheckoutReminderSent(orderId: string): Promise<void> {
    return this.orders.markPaymentCheckoutReminderSent(orderId);
  }

  releasePaymentCheckoutReminder(orderId: string): Promise<void> {
    return this.orders.releasePaymentCheckoutReminder(orderId);
  }

  cancelPaymentCheckoutReminder(orderId: string, telegramId: string): Promise<void> {
    return this.orders.cancelPaymentCheckoutReminder(orderId, telegramId);
  }

  releaseFeedbackClaim(orderId: string): Promise<void> {
    return this.orders.releaseFeedbackClaim(orderId);
  }

  recordFeedback(orderId: string, telegramId: string, response: 'good' | 'discuss' | 'repeat') {
    return this.orders.recordFeedback(orderId, telegramId, response);
  }

  async setDate(
    telegramId: string,
    input: string,
  ): Promise<{ kind: 'saved'; summary: OrderDraftSummary } | { kind: 'invalid' } | { kind: 'missing_draft' }> {
    const preferredDate = parsePublicationDate(input);
    if (!preferredDate) return { kind: 'invalid' };

    const summary = await this.orders.setPreferredDate(telegramId, preferredDate);
    return summary ? { kind: 'saved', summary } : { kind: 'missing_draft' };
  }

  agreeAfterPayment(telegramId: string): Promise<OrderDraftSummary | undefined> {
    return this.orders.setAfterPaymentDate(telegramId);
  }

  async setPublicationDate(telegramId: string, publicationIndex: number, input: string): Promise<OrderDraftSummary | undefined> {
    const date = parsePublicationDate(input);
    return date ? this.orders.setPublicationDate(telegramId, publicationIndex, date) : undefined;
  }

  async setRecurringPublicationDates(
    telegramId: string,
    startInput: string,
    unit: 'days' | 'weeks',
    interval: number,
    weekday?: number,
  ): Promise<OrderDraftSummary | undefined> {
    const startDate = parsePublicationDate(startInput);
    const summary = await this.orders.getDraft(telegramId);
    if (!startDate || !summary || summary.publicationCount < 2 || !Number.isInteger(interval) || interval < 1 || interval > 12) {
      return undefined;
    }

    const stepDays = interval * (unit === 'weeks' ? 7 : 1);
    const start = new Date(`${startDate}T00:00:00.000Z`);
    const isoWeekday = (start.getUTCDay() + 6) % 7 + 1;
    if (unit === 'weeks' && weekday !== undefined && isoWeekday !== weekday) return undefined;
    let updated: OrderDraftSummary | undefined;
    for (let index = 0; index < summary.publicationCount; index++) {
      const date = new Date(start.getTime() + index * stepDays * 86_400_000).toISOString().slice(0, 10);
      updated = await this.orders.setPublicationDate(telegramId, index, date);
      if (!updated) return undefined;
    }
    return updated;
  }

  preparePublicationDateEdit(telegramId: string): Promise<OrderDraftSummary | undefined> {
    return this.orders.preparePublicationDateEdit(telegramId);
  }

  confirmPublicationDate(telegramId: string, orderId: string, publicationIndex: number, expectedDate: string) {
    return this.orders.confirmPublicationDate(telegramId, orderId, publicationIndex, expectedDate);
  }

  requestPublicationDateChange(telegramId: string, orderId: string, publicationIndex: number, expectedDate: string) {
    return this.orders.requestPublicationDateChange(telegramId, orderId, publicationIndex, expectedDate);
  }

  setAwaitingDate(telegramId: string): Promise<OrderDraftSummary | undefined> {
    return this.orders.setAwaitingDate(telegramId);
  }

  confirm(telegramId: string): Promise<CreatedOrder | undefined> {
    return this.orders.createOrder(telegramId);
  }

  reportPayment(orderId: string, telegramId: string, paymentMethod: string): Promise<PaymentReport> {
    return this.orders.reportPayment(orderId, telegramId, paymentMethod);
  }

  requestAlternativePayment(orderId: string, telegramId: string, requestKind: 'alternative' | 'problem' = 'alternative') {
    return this.orders.requestAlternativePayment(orderId, telegramId, requestKind);
  }

  pendingAlternativePaymentRequest(telegramId: string) {
    return this.orders.pendingAlternativePaymentRequest(telegramId);
  }

  submitAlternativePaymentRequest(telegramId: string, message: string) {
    return this.orders.submitAlternativePaymentRequest(telegramId, message);
  }

  cancelAlternativePaymentRequest(telegramId: string) {
    return this.orders.cancelAlternativePaymentRequest(telegramId);
  }

  beginPaymentProof(orderId: string, telegramId: string, paymentMethod: string): Promise<PaymentProofStart> {
    return this.orders.beginPaymentProof(orderId, telegramId, paymentMethod);
  }

  pendingPaymentProof(telegramId: string): Promise<PaymentProofRequest | undefined> {
    return this.orders.pendingPaymentProof(telegramId);
  }

  async submitPaymentProof(telegramId: string, fileId: string): Promise<PaymentReport> {
    const request = await this.orders.pendingPaymentProof(telegramId);
    if (!request) return { kind: 'not_confirmed' };
    const result = await this.orders.reportPayment(request.orderId, telegramId, request.paymentMethod, fileId);
    if (result.kind !== 'created') await this.orders.cancelPaymentProof(request.orderId, telegramId);
    return result;
  }

  cancelPaymentProof(orderId: string, telegramId: string): Promise<void> {
    return this.orders.cancelPaymentProof(orderId, telegramId);
  }

  cancel(telegramId: string): Promise<boolean> {
    return this.orders.cancelDraft(telegramId);
  }
}

/** Accept only DD.MM.YYYY or YYYY-MM-DD and store date-only values as ISO. */
export function parsePublicationDate(input: string): string | undefined {
  const value = input.trim();
  let yearText: string;
  let monthText: string;
  let dayText: string;

  const localized = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(value);
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (localized) {
    [, dayText, monthText, yearText] = localized;
  } else if (iso) {
    [, yearText, monthText, dayText] = iso;
  } else {
    return undefined;
  }

  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);

  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    return undefined;
  }

  const normalized = `${year.toString().padStart(4, '0')}-${month.toString().padStart(2, '0')}-${day.toString().padStart(2, '0')}`;
  if (normalized < new Date().toISOString().slice(0, 10)) return undefined;
  return normalized;
}
