import type { Pool } from 'pg';
import type { AdminFlow } from '../../types/admin.ts';
import { AdminAnalyticsRepository } from './admin/analytics-repository.ts';
import { AdminCatalogRepository } from './admin/catalog-repository.ts';
import { AdminFlowRepository } from './admin/flow-repository.ts';
import { AdminInboxRepository } from './admin/inbox-repository.ts';
import { AdminOrderRepository } from './admin/orders-repository.ts';

/** Exposes the admin data access API while keeping queries grouped by domain. */
export class AdminRepository {
  private readonly database: Pool;
  private readonly flows: AdminFlowRepository;
  private readonly catalog: AdminCatalogRepository;
  private readonly inbox: AdminInboxRepository;
  private readonly orders: AdminOrderRepository;
  private readonly analytics: AdminAnalyticsRepository;

  constructor(database: Pool) {
    this.database = database;
    this.flows = new AdminFlowRepository(database);
    this.catalog = new AdminCatalogRepository(database);
    this.inbox = new AdminInboxRepository(database);
    this.orders = new AdminOrderRepository(database);
    this.analytics = new AdminAnalyticsRepository(database);
  }

  getFlow(telegramId: string) {
    return this.flows.getFlow(telegramId);
  }

  saveFlow(telegramId: string, flow: AdminFlow) {
    return this.flows.saveFlow(telegramId, flow);
  }

  savePromotionalDraftFlow(telegramId: string, flow: AdminFlow) {
    return this.flows.savePromotionalDraftFlow(telegramId, flow);
  }

  clearFlow(telegramId: string) {
    return this.flows.clearFlow(telegramId);
  }

  clearPromotionalDraftFlow(telegramId: string, token: string) {
    return this.flows.clearPromotionalDraftFlow(telegramId, token);
  }

  claimPromotionalBroadcast(telegramId: string, expected: AdminFlow) {
    return this.flows.claimPromotionalBroadcast(telegramId, expected);
  }

  clearClaimedPromotionalBroadcast(telegramId: string, token: string) {
    return this.flows.clearClaimedPromotionalBroadcast(telegramId, token);
  }

  async listPromotionalRecipients(): Promise<string[]> {
    const result = await this.database.query<{ telegram_id: string }>(
      `SELECT telegram_id::text FROM users
       WHERE monthly_promotions = true
       ORDER BY telegram_id`,
    );
    return result.rows.map((row) => row.telegram_id);
  }

  async hasPromotionalConsent(telegramId: string): Promise<boolean> {
    const result = await this.database.query<{ monthly_promotions: boolean }>(
      `SELECT monthly_promotions FROM users WHERE telegram_id = $1`,
      [telegramId],
    );
    return result.rows[0]?.monthly_promotions ?? false;
  }

  async confirmPromotionalBroadcastSchedule(
    adminTelegramId: string,
    expectedFlow: AdminFlow,
    text: string,
    media: { type: 'photo' | 'video'; fileId: string }[],
    scheduledAt: Date,
  ): Promise<
    | { kind: 'saved'; id: string; scheduledAt: Date }
    | { kind: 'conflict' }
    | { kind: 'unavailable' }
  > {
    const client = await this.database.connect();
    try {
      await client.query('BEGIN');
      const flowResult = await client.query<{
        admin_id: string; flow_type: string; step: number; payload: Record<string, string>;
      }>(
        `SELECT flow.admin_id, flow.flow_type, flow.step, flow.payload
         FROM admin_flows AS flow
         JOIN admins AS admin ON admin.id = flow.admin_id
         WHERE admin.telegram_id = $1 AND admin.is_active = true
           AND flow.flow_type = 'promotional_broadcast' AND flow.step = $3
           AND flow.payload = $2::jsonb
         FOR UPDATE OF flow`,
        [adminTelegramId, JSON.stringify(expectedFlow.payload), expectedFlow.step],
      );
      const flow = flowResult.rows[0];
      const existingId = expectedFlow.payload.scheduledBroadcastId;
      const allowedExistingEditStep = Boolean(existingId) && [1, 7].includes(expectedFlow.step);
      if (!flow || (existingId ? !allowedExistingEditStep : expectedFlow.step !== 7)) {
        await client.query('COMMIT');
        return { kind: 'conflict' };
      }

      const savedResult = existingId
        ? await client.query<{ id: string; scheduled_at: Date }>(
          `UPDATE scheduled_promotional_broadcasts
           SET message_text = $3, media = $4::jsonb, scheduled_at = $5
           WHERE id = $1 AND admin_telegram_id = $2 AND status = 'pending'
             AND $5 > now()
           RETURNING id, scheduled_at`,
          [existingId, adminTelegramId, text, JSON.stringify(media), scheduledAt],
        )
        : await client.query<{ id: string; scheduled_at: Date }>(
          `INSERT INTO scheduled_promotional_broadcasts
             (admin_telegram_id, message_text, media, scheduled_at)
           VALUES ($1, $2, $3::jsonb, $4)
           RETURNING id, scheduled_at`,
          [adminTelegramId, text, JSON.stringify(media), scheduledAt],
        );
      const saved = savedResult.rows[0];
      if (!saved) {
        await client.query('COMMIT');
        return { kind: 'unavailable' };
      }

      const cleared = await client.query(
        `DELETE FROM admin_flows
         WHERE admin_id = $1 AND flow_type = 'promotional_broadcast'
           AND step = $3 AND payload = $2::jsonb
         RETURNING admin_id`,
        [flow.admin_id, JSON.stringify(expectedFlow.payload), expectedFlow.step],
      );
      if ((cleared.rowCount ?? 0) !== 1) throw new Error('Promotional broadcast flow changed during schedule confirmation.');
      await client.query('COMMIT');
      return { kind: 'saved', id: saved.id, scheduledAt: saved.scheduled_at };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async listPendingPromotionalBroadcasts(
    adminTelegramId: string,
    limit = 20,
    offset = 0,
  ): Promise<Array<{ id: string; text: string; media: unknown; scheduledAt: Date }>> {
    const result = await this.database.query<{
      id: string; message_text: string; media: unknown; scheduled_at: Date;
    }>(
      `SELECT id, message_text, media, scheduled_at
       FROM scheduled_promotional_broadcasts
       WHERE admin_telegram_id = $1 AND status = 'pending'
       ORDER BY scheduled_at, created_at
       LIMIT $2 OFFSET $3`,
      [adminTelegramId, limit, offset],
    );
    return result.rows.map((row) => ({
      id: row.id, text: row.message_text, media: row.media, scheduledAt: row.scheduled_at,
    }));
  }

  async countPendingPromotionalBroadcasts(adminTelegramId: string): Promise<number> {
    const result = await this.database.query<{ count: string }>(
      `SELECT count(*)::text AS count
       FROM scheduled_promotional_broadcasts
       WHERE admin_telegram_id = $1 AND status = 'pending'`,
      [adminTelegramId],
    );
    return Number(result.rows[0]?.count ?? 0);
  }

  async getPendingPromotionalBroadcast(
    id: string,
    adminTelegramId: string,
  ): Promise<{ id: string; text: string; media: unknown; scheduledAt: Date } | undefined> {
    const result = await this.database.query<{
      id: string; message_text: string; media: unknown; scheduled_at: Date;
    }>(
      `SELECT id, message_text, media, scheduled_at
       FROM scheduled_promotional_broadcasts
       WHERE id = $1 AND admin_telegram_id = $2 AND status = 'pending'`,
      [id, adminTelegramId],
    );
    const row = result.rows[0];
    return row ? { id: row.id, text: row.message_text, media: row.media, scheduledAt: row.scheduled_at } : undefined;
  }

  async cancelScheduledPromotionalBroadcast(id: string, adminTelegramId: string): Promise<boolean> {
    const result = await this.database.query(
      `UPDATE scheduled_promotional_broadcasts
       SET status = 'cancelled'
       WHERE id = $1 AND admin_telegram_id = $2 AND status = 'pending'`,
      [id, adminTelegramId],
    );
    return (result.rowCount ?? 0) === 1;
  }

  async claimDuePromotionalBroadcast(): Promise<{
    id: string;
    adminTelegramId: string;
    text: string;
    media: unknown;
  } | undefined> {
    const result = await this.database.query<{
      id: string; admin_telegram_id: string; message_text: string; media: unknown;
    }>(
      `WITH due AS (
         SELECT id FROM scheduled_promotional_broadcasts
         WHERE status = 'pending' AND scheduled_at <= now()
         ORDER BY scheduled_at, created_at
         FOR UPDATE SKIP LOCKED
         LIMIT 1
       )
       UPDATE scheduled_promotional_broadcasts AS broadcast
       SET status = 'sending', started_at = now()
       FROM due
       WHERE broadcast.id = due.id
       RETURNING broadcast.id, broadcast.admin_telegram_id::text,
         broadcast.message_text, broadcast.media`,
    );
    const row = result.rows[0];
    return row ? {
      id: row.id,
      adminTelegramId: row.admin_telegram_id,
      text: row.message_text,
      media: row.media,
    } : undefined;
  }

  async completePromotionalBroadcast(id: string): Promise<void> {
    await this.database.query(
      `UPDATE scheduled_promotional_broadcasts
       SET status = 'sent', completed_at = now()
       WHERE id = $1 AND status = 'sending'`,
      [id],
    );
  }

  listTariffs() {
    return this.catalog.listTariffs();
  }

  createTariff(
    name: string,
    platforms: string,
    inclusions: string,
    publicationCount: number | null,
    placementDuration: string,
    feedbackDelayDays: number,
    description: string,
    price: string,
    discountValidUntil: string | null,
  ) {
    return this.catalog.createTariff(name, platforms, inclusions, publicationCount, placementDuration, feedbackDelayDays, description, price, discountValidUntil);
  }

  updateTariff(
    id: string,
    name: string,
    platforms: string,
    inclusions: string,
    publicationCount: number | null,
    placementDuration: string,
    feedbackDelayDays: number,
    description: string,
    price: string,
    discountValidUntil: string | null,
  ) {
    return this.catalog.updateTariff(id, name, platforms, inclusions, publicationCount, placementDuration, feedbackDelayDays, description, price, discountValidUntil);
  }

  setTariffActive(id: string, isActive: boolean) {
    return this.catalog.setTariffActive(id, isActive);
  }

  deleteTariff(id: string) {
    return this.catalog.deleteTariff(id);
  }

  getPaymentMethodRequest(id: string) {
    return this.catalog.getPaymentMethodRequest(id);
  }

  markPaymentMethodRequestAnswered(id: string) {
    return this.catalog.markPaymentMethodRequestAnswered(id);
  }

  listBusinessLeads(days: number | null = null, search: string | null = null) {
    return this.catalog.listBusinessLeads(days, search);
  }

  countBusinessLeads() {
    return this.catalog.countBusinessLeads();
  }

  listNewUserBusinessLeads() {
    return this.catalog.listNewUserBusinessLeads();
  }

  countNewUserBusinessLeads() {
    return this.catalog.countNewUserBusinessLeads();
  }

  listInquiries() {
    return this.catalog.listInquiries();
  }

  listDataDeletionRequests() {
    return this.catalog.listDataDeletionRequests();
  }

  getInquiry(inquiryId: string) {
    return this.catalog.getInquiry(inquiryId);
  }

  deleteInquiry(inquiryId: string) {
    return this.catalog.deleteInquiry(inquiryId);
  }

  deleteUserDataForInquiry(inquiryId: string) {
    return this.catalog.deleteUserDataForInquiry(inquiryId);
  }

  getInboxCounts() {
    return this.inbox.getInboxCounts();
  }

  async schedulePaymentCheckoutReminder(orderId: string, telegramId: string): Promise<boolean> {
    const result = await this.database.query(
      `INSERT INTO payment_checkout_reminders (order_id, user_id, due_at, sent_at, claimed_at, updated_at)
       SELECT order_record.id, order_record.user_id, now() + interval '30 minutes', NULL, NULL, now()
       FROM orders AS order_record
       JOIN users AS app_user ON app_user.id = order_record.user_id
       WHERE order_record.id = $1 AND app_user.telegram_id = $2
         AND order_record.status = 'confirmed'
         AND NOT EXISTS (SELECT 1 FROM payments WHERE payments.order_id = order_record.id AND payments.status <> 'rejected')
       ON CONFLICT (order_id) DO UPDATE SET due_at = EXCLUDED.due_at, sent_at = NULL,
         claimed_at = NULL, updated_at = now()`,
      [orderId, telegramId],
    );
    return (result.rowCount ?? 0) > 0;
  }

  getFeedbackCounts() {
    return this.inbox.getFeedbackCounts();
  }

  listFeedback(filter: 'all' | 'positive' | 'discussions' = 'all') {
    return this.inbox.listFeedback(filter);
  }

  listRecentFeedback() {
    return this.inbox.listFeedback('all', true);
  }

  getFeedback(orderId: string) {
    return this.inbox.getFeedback(orderId);
  }

  listFeedbackMessages(orderId: string) {
    return this.inbox.listFeedbackMessages(orderId);
  }

  startFeedbackInput(telegramId: string, orderId: string, senderType: 'user' | 'admin', mode: 'review' | 'message') {
    return this.inbox.startFeedbackInput(telegramId, orderId, senderType, mode);
  }

  hasFeedbackInput(telegramId: string) {
    return this.inbox.hasFeedbackInput(telegramId);
  }

  cancelFeedbackInput(telegramId: string) {
    return this.inbox.cancelFeedbackInput(telegramId);
  }

  completeFeedbackInput(telegramId: string, message: string) {
    return this.inbox.completeFeedbackInput(telegramId, message);
  }

  setFeedbackStatus(orderId: string, status: 'open' | 'closed') {
    return this.inbox.setFeedbackStatus(orderId, status);
  }

  getInboxMessageId(telegramId: string) {
    return this.inbox.getInboxMessageId(telegramId);
  }

  saveInboxMessageId(telegramId: string, messageId: number) {
    return this.inbox.saveInboxMessageId(telegramId, messageId);
  }

  listPendingPayments() {
    return this.inbox.listPendingPayments();
  }

  reviewPayment(paymentId: string, adminTelegramId: string, approved: boolean) {
    return this.inbox.reviewPayment(paymentId, adminTelegramId, approved);
  }

  listOrders(status: string | null = null) {
    return this.orders.listOrders(status);
  }

  getOrderStatusCounts() {
    return this.orders.getOrderStatusCounts();
  }

  listMaterialSubmissions(includeApproved = false) {
    return this.orders.listMaterialSubmissions(includeApproved);
  }

  listMaterialSubmissionsByStatus(status: 'submitted' | 'approved') {
    return this.orders.listMaterialSubmissions(true, status);
  }

  getMaterialStatusCounts() {
    return this.inbox.getMaterialStatusCounts();
  }

  getMaterialSubmission(orderId: string, includeApproved = false) {
    return this.orders.getMaterialSubmission(orderId, includeApproved);
  }

  setMaterialStatus(orderId: string, status: 'approved' | 'rejected') {
    return this.orders.setMaterialStatus(orderId, status);
  }

  requestMaterialCorrections(orderId: string, comment: string) {
    return this.orders.requestMaterialCorrections(orderId, comment);
  }

  changeOrderStatus(orderId: string, adminTelegramId: string, status: 'confirmed' | 'rejected' | 'cancelled' | 'completed') {
    return this.orders.changeOrderStatus(orderId, adminTelegramId, status);
  }

  markOrderPublished(orderId: string, publicationIndex: number, publicationLink: string | null) {
    return this.orders.markOrderPublished(orderId, publicationIndex, publicationLink);
  }

  scheduleOrder(orderId: string, scheduledAt: string) {
    return this.orders.scheduleOrder(orderId, scheduledAt);
  }

  getOrderDateInfo(orderId: string) {
    return this.orders.getOrderDateInfo(orderId);
  }

  updateOrderPublicationDate(orderId: string, index: number, date: string) {
    return this.orders.updateOrderPublicationDate(orderId, index, date);
  }

  recordMessage(adminTelegramId: string, userTelegramId: string, message: string) {
    return this.orders.recordMessage(adminTelegramId, userTelegramId, message);
  }

  getStatistics() {
    return this.analytics.getStatistics();
  }

  getPopularTariffs() {
    return this.analytics.getPopularTariffs();
  }

  getReferralOverview() {
    return this.analytics.getReferralOverview();
  }

  getReferralBonusSettings() {
    return this.analytics.getReferralBonusSettings();
  }

  updateReferralBonusSettings(settings: import('../../types/admin.ts').ReferralBonusSettings) {
    return this.analytics.updateReferralBonusSettings(settings);
  }
}
