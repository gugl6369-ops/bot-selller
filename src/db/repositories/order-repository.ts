import type { Pool } from 'pg';
import type {
  CreatedOrder,
  OrderDraftSummary,
  OrderHistoryStatus,
  PaymentProofRequest,
  PaymentProofStart,
  PaymentHistoryStatus,
  PaymentReport,
  UserOrderHistoryItem,
} from '../../types/order.ts';

export class OrderRepository {
  private readonly database: Pool;

  constructor(database: Pool) {
    this.database = database;
  }

  async hasSubmittedOrder(telegramId: string): Promise<boolean> {
    const result = await this.database.query<{ has_order: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM orders AS order_record
         JOIN users AS app_user ON app_user.id = order_record.user_id
         WHERE app_user.telegram_id = $1
       ) AS has_order`,
      [telegramId],
    );
    return result.rows[0]?.has_order ?? false;
  }

  async requestAlternativePayment(orderId: string, telegramId: string, requestKind: 'alternative' | 'problem' = 'alternative') {
    const result = await this.database.query<{
      request_id: string; order_number: string; price: string; currency: string;
    }>(
      `WITH eligible AS (
         SELECT order_record.id, order_record.user_id, order_record.order_number, order_record.price, order_record.currency
         FROM orders AS order_record
         JOIN users AS app_user ON app_user.id = order_record.user_id
         WHERE order_record.id = $1 AND app_user.telegram_id = $2 AND order_record.status = 'confirmed'
           AND NOT EXISTS (SELECT 1 FROM payments WHERE order_id = order_record.id AND status <> 'rejected')
       ), inserted AS (
         INSERT INTO payment_method_requests (order_id, user_id, request_kind)
         SELECT id, user_id, $3 FROM eligible
         RETURNING id, order_id
       )
       SELECT inserted.id AS request_id, eligible.order_number::text, eligible.price::text, eligible.currency
       FROM inserted JOIN eligible ON eligible.id = inserted.order_id`,
      [orderId, telegramId, requestKind],
    );
    const row = result.rows[0];
    return row ? {
      requestId: row.request_id, orderId, orderNumber: row.order_number, amount: row.price, currency: row.currency,
    } : undefined;
  }

  async pendingAlternativePaymentRequest(telegramId: string) {
    const result = await this.database.query<{ id: string; order_number: string }>(
      `SELECT request.id, order_record.order_number::text
       FROM payment_method_requests AS request
       JOIN orders AS order_record ON order_record.id = request.order_id
       JOIN users AS app_user ON app_user.id = request.user_id
       WHERE app_user.telegram_id = $1 AND request.status = 'pending' AND request.message IS NULL
       ORDER BY request.created_at DESC LIMIT 1`,
      [telegramId],
    );
    const row = result.rows[0];
    return row ? { requestId: row.id, orderNumber: row.order_number } : undefined;
  }

  async submitAlternativePaymentRequest(telegramId: string, message: string) {
    const result = await this.database.query<{
      request_id: string; order_id: string; order_number: string; telegram_id: string;
      first_name: string; username: string | null; business_name: string; price: string; currency: string;
      admin_ids: string[]; message: string; request_kind: 'alternative' | 'problem';
    }>(
      `WITH updated AS (
         UPDATE payment_method_requests AS request SET message = $2
         FROM orders AS order_record, users AS app_user
         WHERE request.order_id = order_record.id AND request.user_id = app_user.id
           AND app_user.telegram_id = $1 AND request.status = 'pending' AND request.message IS NULL
           AND order_record.status = 'confirmed'
         RETURNING request.id, request.order_id, request.user_id, request.message, request.request_kind
       )
       SELECT updated.id AS request_id, order_record.id AS order_id, order_record.order_number::text,
         app_user.telegram_id::text, app_user.first_name, app_user.username, business.name AS business_name,
         order_record.price::text, order_record.currency, updated.message, updated.request_kind,
         ARRAY(SELECT telegram_id::text FROM admins WHERE is_active = true) AS admin_ids
       FROM updated JOIN orders AS order_record ON order_record.id = updated.order_id
       JOIN users AS app_user ON app_user.id = updated.user_id
       JOIN businesses AS business ON business.id = order_record.business_id`,
      [telegramId, message],
    );
    const row = result.rows[0];
    return row ? {
      requestId: row.request_id, orderId: row.order_id, orderNumber: row.order_number,
      telegramId: row.telegram_id, firstName: row.first_name, username: row.username,
      businessName: row.business_name, amount: row.price, currency: row.currency,
      adminTelegramIds: row.admin_ids, message: row.message, requestKind: row.request_kind,
    } : undefined;
  }

  async cancelAlternativePaymentRequest(telegramId: string): Promise<void> {
    await this.database.query(
      `DELETE FROM payment_method_requests AS request USING users AS app_user
       WHERE request.user_id = app_user.id AND app_user.telegram_id = $1
         AND request.status = 'pending' AND request.message IS NULL`,
      [telegramId],
    );
  }

  async createDraft(telegramId: string, tariffId: string): Promise<boolean> {
    const client = await this.database.connect();
    try {
      await client.query('BEGIN');
      const user = await client.query<{ id: string }>(
        `SELECT id FROM users WHERE telegram_id = $1 FOR UPDATE`,
        [telegramId],
      );
      const userId = user.rows[0]?.id;
      if (!userId) throw new Error(`Telegram user ${telegramId} is not registered.`);

      const business = await client.query<{ id: string }>(
        `SELECT id FROM businesses WHERE user_id = $1 ORDER BY created_at ASC LIMIT 1`,
        [userId],
      );
      const businessId = business.rows[0]?.id;
      if (!businessId) {
        await client.query('COMMIT');
        return false;
      }

      const tariff = await client.query<{ id: string }>(
        `SELECT id FROM tariffs WHERE id = $1 AND is_active = true`,
        [tariffId],
      );
      if (!tariff.rows[0]) {
        await client.query('COMMIT');
        return false;
      }

      await client.query(
        `INSERT INTO order_drafts (user_id, business_id, tariff_id, status, preferred_date, publication_dates)
         VALUES ($1, $2, $3, 'awaiting_date', NULL,
           ARRAY(SELECT ''::text FROM generate_series(1, COALESCE((SELECT publication_count FROM tariffs WHERE id = $3), 1))))
         ON CONFLICT (user_id) DO UPDATE
         SET business_id = EXCLUDED.business_id,
             tariff_id = EXCLUDED.tariff_id,
             status = CASE WHEN order_drafts.tariff_id = EXCLUDED.tariff_id THEN order_drafts.status ELSE 'awaiting_date' END,
             preferred_date = CASE WHEN order_drafts.tariff_id = EXCLUDED.tariff_id THEN order_drafts.preferred_date ELSE NULL END,
             publication_dates = CASE WHEN order_drafts.tariff_id = EXCLUDED.tariff_id THEN order_drafts.publication_dates ELSE EXCLUDED.publication_dates END,
             updated_at = now()`,
        [userId, businessId, tariffId],
      );
      await client.query('COMMIT');
      return true;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async getDraft(telegramId: string): Promise<OrderDraftSummary | undefined> {
    const result = await this.database.query<{
      tariff_id: string;
      name: string;
      description: string;
      original_price: string;
      discount_amount: string;
      final_price: string;
      currency: string;
      preferred_date: string | null;
      publication_count: number | null;
      publication_dates: string[];
      status: 'awaiting_date' | 'ready';
    }>(
      `SELECT tariff.id AS tariff_id, tariff.name,
         COALESCE(NULLIF(CONCAT_WS(E'\\n',
           CASE WHEN NULLIF(BTRIM(tariff.platforms), '') IS NOT NULL THEN 'Площадки: ' || tariff.platforms END,
           CASE WHEN NULLIF(BTRIM(tariff.inclusions), '') IS NOT NULL THEN 'Включено: ' || tariff.inclusions END,
           CASE WHEN tariff.publication_count IS NOT NULL THEN 'Публикаций: ' || tariff.publication_count::text END,
           CASE WHEN NULLIF(BTRIM(tariff.placement_duration), '') IS NOT NULL THEN 'Срок размещения: ' || tariff.placement_duration END,
           NULLIF(BTRIM(tariff.description), '')
         ), ''), 'Условия размещения уточняются.') AS description,
         tariff.price::numeric(12,2)::text AS original_price,
         CASE WHEN NOT EXISTS (
           SELECT 1 FROM orders
           WHERE user_id = draft.user_id AND status NOT IN ('rejected', 'cancelled')
         ) AND tariff.discount_valid_until >= CURRENT_DATE
           THEN (tariff.price * 0.1)::numeric(12,2)::text ELSE '0.00' END AS discount_amount,
         CASE WHEN NOT EXISTS (
           SELECT 1 FROM orders
           WHERE user_id = draft.user_id AND status NOT IN ('rejected', 'cancelled')
         ) AND tariff.discount_valid_until >= CURRENT_DATE
           THEN (tariff.price * 0.9)::numeric(12,2)::text ELSE tariff.price::numeric(12,2)::text END AS final_price,
         tariff.currency, draft.preferred_date, COALESCE(tariff.publication_count, 1) AS publication_count,
         draft.publication_dates, draft.status
       FROM order_drafts AS draft
       JOIN users AS app_user ON app_user.id = draft.user_id
       JOIN tariffs AS tariff ON tariff.id = draft.tariff_id AND tariff.is_active = true
       WHERE app_user.telegram_id = $1`,
      [telegramId],
    );
    const row = result.rows[0];
    return row
      ? {
          tariffId: row.tariff_id,
          name: row.name,
          description: row.description,
          originalPrice: row.original_price,
          discountAmount: row.discount_amount,
          finalPrice: row.final_price,
          currency: row.currency,
          preferredDate: row.preferred_date,
          publicationCount: row.publication_count ?? 1,
          publicationDates: row.publication_dates,
          status: row.status,
        }
      : undefined;
  }

  async listUserOrders(telegramId: string, list: 'active' | 'history'): Promise<UserOrderHistoryItem[]> {
    const result = await this.database.query<{
      id: string;
      tariff_id: string;
      order_number: string;
      tariff_name_snapshot: string;
      tariff_description_snapshot: string;
      status: OrderHistoryStatus;
      price: string;
      currency: string;
      publication_dates: string[];
      publication_statuses: string[];
      publication_links: (string | null)[];
      publication_at: Date | null;
      created_at: Date;
      payment_status: PaymentHistoryStatus | null;
      materials_status: 'collecting' | 'submitted' | null;
      feedback_response: 'good' | 'discuss' | 'repeat' | null;
      feedback_review: string | null;
    }>(
      `SELECT order_record.id, order_record.tariff_id, order_record.order_number::text,
         order_record.tariff_name_snapshot, order_record.tariff_description_snapshot,
         order_record.status, order_record.price::numeric(12,2)::text AS price,
         order_record.currency, order_record.publication_dates, order_record.publication_statuses,
         CASE WHEN cardinality(order_record.publication_links) = 0 AND order_record.publication_link IS NOT NULL
           THEN ARRAY[order_record.publication_link] ELSE order_record.publication_links END AS publication_links,
         order_record.publication_at,
         order_record.created_at, payment.status AS payment_status,
         order_record.feedback_response, feedback.review_text AS feedback_review,
         materials.status AS materials_status
       FROM orders AS order_record
       JOIN users AS app_user ON app_user.id = order_record.user_id
       LEFT JOIN payments AS payment ON payment.order_id = order_record.id
       LEFT JOIN order_feedback AS feedback ON feedback.order_id = order_record.id
       LEFT JOIN order_material_submissions AS materials ON materials.order_id = order_record.id
       WHERE app_user.telegram_id = $1
         AND (($2 = 'active' AND order_record.status IN ('pending_confirmation', 'confirmed'))
           OR ($2 = 'history' AND order_record.status IN ('rejected', 'cancelled', 'completed')))
       ORDER BY order_record.created_at DESC
       LIMIT 20`,
      [telegramId, list],
    );
    return result.rows.map((row) => ({
      id: row.id,
      tariffId: row.tariff_id,
      orderNumber: row.order_number,
      tariffName: row.tariff_name_snapshot,
      tariffDescription: row.tariff_description_snapshot,
      status: row.status,
      price: row.price,
      currency: row.currency,
      requestedPublicationDates: row.publication_dates,
      publicationStatuses: row.publication_statuses,
      publicationLinks: row.publication_links,
      publicationAt: row.publication_at?.toISOString() ?? null,
      createdAt: row.created_at.toISOString(),
      paymentStatus: row.payment_status,
      materialsStatus: row.materials_status,
      feedbackResponse: row.feedback_response,
      feedbackReview: row.feedback_review,
    }));
  }

  async claimDueFeedback(): Promise<Array<{
    id: string;
    telegramId: string;
    orderNumber: string;
    businessName: string;
    tariffName: string;
    feedbackDelayDays: number;
  }>> {
    const result = await this.database.query<{
      id: string;
      telegram_id: string;
      order_number: string;
      business_name: string;
      tariff_name: string;
      feedback_delay_days_snapshot: number;
    }>(
      `WITH due AS (
         SELECT order_record.id FROM orders AS order_record
         JOIN users AS app_user ON app_user.id = order_record.user_id
         WHERE order_record.status = 'completed' AND order_record.feedback_due_at <= now()
           AND order_record.feedback_due_at IS NOT NULL
           AND cardinality(order_record.publication_statuses) > 0
           AND NOT EXISTS (
             SELECT 1 FROM unnest(order_record.publication_statuses) AS publication_status(value)
             WHERE publication_status.value <> 'published'
           )
           AND app_user.feedback_requests = true
           AND order_record.feedback_sent_at IS NULL AND order_record.feedback_response IS NULL
           AND (order_record.feedback_claimed_at IS NULL OR order_record.feedback_claimed_at < now() - interval '10 minutes')
           ORDER BY order_record.feedback_due_at ASC LIMIT 25 FOR UPDATE OF order_record SKIP LOCKED
       )
       UPDATE orders AS order_record SET feedback_claimed_at = now()
       FROM due, users AS app_user, businesses AS business
       WHERE order_record.id = due.id AND app_user.id = order_record.user_id
         AND business.id = order_record.business_id
       RETURNING order_record.id, app_user.telegram_id::text, order_record.order_number::text,
         business.name AS business_name, order_record.tariff_name_snapshot AS tariff_name,
         order_record.feedback_delay_days_snapshot`,
    );
    return result.rows.map((row) => ({
      id: row.id,
      telegramId: row.telegram_id,
      orderNumber: row.order_number,
      businessName: row.business_name,
      tariffName: row.tariff_name,
      feedbackDelayDays: row.feedback_delay_days_snapshot,
    }));
  }

  async markFeedbackSent(orderId: string): Promise<void> {
    await this.database.query(
      `UPDATE orders SET feedback_sent_at = now(), feedback_claimed_at = NULL, updated_at = now()
       WHERE id = $1 AND status = 'completed' AND feedback_sent_at IS NULL`,
      [orderId],
    );
  }

  async releaseFeedbackClaim(orderId: string): Promise<void> {
    await this.database.query(
      `UPDATE orders SET feedback_claimed_at = NULL WHERE id = $1 AND feedback_sent_at IS NULL`,
      [orderId],
    );
  }

  async recordFeedback(orderId: string, telegramId: string, response: 'good' | 'discuss' | 'repeat'): Promise<{
    orderNumber: string;
    tariffName: string;
    businessName: string;
    firstName: string;
    username: string | null;
    adminTelegramIds: string[];
  } | undefined> {
    const result = await this.database.query<{
      order_number: string;
      tariff_name: string;
      business_name: string;
      first_name: string;
      username: string | null;
    }>(
      `WITH changed AS (
         UPDATE orders AS order_record SET feedback_response = $3,
           feedback_sent_at = COALESCE(feedback_sent_at, now()), updated_at = now()
         FROM users AS app_user
         WHERE order_record.id = $1 AND order_record.user_id = app_user.id
           AND app_user.telegram_id = $2 AND order_record.status = 'completed'
           AND order_record.feedback_response IS NULL
           AND cardinality(order_record.publication_statuses) > 0
           AND NOT EXISTS (
             SELECT 1 FROM unnest(order_record.publication_statuses) AS publication_status(value)
             WHERE publication_status.value <> 'published'
           )
         RETURNING order_record.id, order_record.user_id, order_record.feedback_response,
           order_record.order_number::text AS order_number,
           order_record.tariff_name_snapshot AS tariff_name,
           order_record.business_id
       ), saved AS (
         INSERT INTO order_feedback (order_id, user_id, response, status)
         SELECT changed.id, changed.user_id, changed.feedback_response,
           CASE WHEN changed.feedback_response = 'discuss' THEN 'open' ELSE 'closed' END
         FROM changed
         ON CONFLICT (order_id) DO NOTHING
         RETURNING order_id
       )
       SELECT changed.order_number, changed.tariff_name, business.name AS business_name,
         app_user.first_name, app_user.username
       FROM changed
       JOIN users AS app_user ON app_user.id = changed.user_id
       JOIN businesses AS business ON business.id = changed.business_id
       JOIN saved ON saved.order_id = changed.id`,
      [orderId, telegramId, response],
    );
    const row = result.rows[0];
    if (!row) return undefined;
    const admins = await this.database.query<{ telegram_id: string }>(
      `SELECT telegram_id::text FROM admins WHERE is_active = true ORDER BY telegram_id`,
    );
    return {
      orderNumber: row.order_number,
      tariffName: row.tariff_name,
      businessName: row.business_name,
      firstName: row.first_name,
      username: row.username,
      adminTelegramIds: admins.rows.map((admin) => admin.telegram_id),
    };
  }

  async setPreferredDate(telegramId: string, preferredDate: string): Promise<OrderDraftSummary | undefined> {
    const result = await this.database.query(
      `UPDATE order_drafts SET preferred_date = $2, publication_dates = ARRAY[$2]::text[], status = 'ready', updated_at = now()
       WHERE status = 'awaiting_date'
         AND user_id = (SELECT id FROM users WHERE telegram_id = $1)`,
      [telegramId, preferredDate],
    );
    if (!result.rowCount) return undefined;
    return this.getDraft(telegramId);
  }

  async setPublicationDate(telegramId: string, publicationIndex: number, date: string): Promise<OrderDraftSummary | undefined> {
    const result = await this.database.query(
      `UPDATE order_drafts SET
         publication_dates[ $2 + 1 ] = $3,
         preferred_date = CASE WHEN $2 = 0 THEN $3 ELSE preferred_date END,
         status = CASE WHEN NOT EXISTS (
           SELECT 1 FROM unnest(publication_dates) WITH ORDINALITY AS existing_dates(value, position)
           WHERE existing_dates.position <> $2 + 1 AND (existing_dates.value IS NULL OR existing_dates.value = '')
         )
           THEN 'ready' ELSE 'awaiting_date' END,
         updated_at = now()
       WHERE user_id = (SELECT id FROM users WHERE telegram_id = $1)
         AND $2 >= 0 AND $2 < cardinality(publication_dates)`,
      [telegramId, publicationIndex, date],
    );
    return result.rowCount ? this.getDraft(telegramId) : undefined;
  }

  async preparePublicationDateEdit(telegramId: string): Promise<OrderDraftSummary | undefined> {
    await this.database.query(
      `UPDATE order_drafts SET status = CASE WHEN NOT EXISTS (
           SELECT 1 FROM unnest(publication_dates) AS existing_dates(value)
           WHERE existing_dates.value IS NULL OR existing_dates.value = ''
         ) THEN 'ready' ELSE 'awaiting_date' END,
         updated_at = now()
       WHERE user_id = (SELECT id FROM users WHERE telegram_id = $1) AND cardinality(publication_dates) > 1`,
      [telegramId],
    );
    return this.getDraft(telegramId);
  }

  async setAfterPaymentDate(telegramId: string): Promise<OrderDraftSummary | undefined> {
    await this.database.query(
      `UPDATE order_drafts SET preferred_date = NULL,
         publication_dates = ARRAY(SELECT ''::text FROM generate_series(1, cardinality(publication_dates))),
         status = 'ready', updated_at = now()
       WHERE user_id = (SELECT id FROM users WHERE telegram_id = $1)`,
      [telegramId],
    );
    return this.getDraft(telegramId);
  }

  async setAwaitingDate(telegramId: string): Promise<OrderDraftSummary | undefined> {
    await this.database.query(
      `UPDATE order_drafts SET preferred_date = NULL,
         publication_dates = ARRAY(SELECT ''::text FROM generate_series(1, cardinality(publication_dates))),
         status = 'awaiting_date', updated_at = now()
       WHERE user_id = (SELECT id FROM users WHERE telegram_id = $1)`,
      [telegramId],
    );
    return this.getDraft(telegramId);
  }

  async confirmPublicationDate(telegramId: string, orderId: string, publicationIndex: number, expectedDate: string): Promise<{
    orderNumber: string;
    publicationNumber: number;
    date: string;
    adminTelegramIds: string[];
  } | undefined> {
    const result = await this.database.query<{
      order_number: string;
      publication_number: number;
      publication_date: string;
      admin_telegram_ids: string[];
    }>(
      `WITH confirmed AS (
         UPDATE orders AS order_record
         SET publication_date_statuses[$3 + 1] = 'confirmed', updated_at = now()
         FROM users AS app_user
         WHERE order_record.user_id = app_user.id AND app_user.telegram_id = $1
           AND order_record.id = $2 AND order_record.status = 'confirmed'
           AND $3 >= 0 AND $3 < cardinality(order_record.publication_dates)
           AND COALESCE(order_record.publication_dates[$3 + 1], '') <> ''
           AND order_record.publication_dates[$3 + 1] = $4
           AND COALESCE(order_record.publication_date_statuses[$3 + 1], 'awaiting_admin') = 'awaiting_user'
         RETURNING order_record.order_number, order_record.publication_dates[$3 + 1] AS publication_date
       )
       SELECT confirmed.order_number::text, $3 + 1 AS publication_number, confirmed.publication_date,
         ARRAY(SELECT telegram_id::text FROM admins WHERE is_active = true ORDER BY telegram_id) AS admin_telegram_ids
       FROM confirmed`,
      [telegramId, orderId, publicationIndex, expectedDate],
    );
    const row = result.rows[0];
    return row ? {
      orderNumber: row.order_number,
      publicationNumber: row.publication_number,
      date: row.publication_date,
      adminTelegramIds: row.admin_telegram_ids,
    } : undefined;
  }

  async requestPublicationDateChange(telegramId: string, orderId: string, publicationIndex: number, expectedDate: string): Promise<{
    orderNumber: string;
    publicationNumber: number;
    date: string;
    adminTelegramIds: string[];
  } | undefined> {
    const result = await this.database.query<{
      order_number: string;
      publication_number: number;
      publication_date: string;
      admin_telegram_ids: string[];
    }>(
      `WITH requested AS (
         UPDATE orders AS order_record
         SET publication_date_statuses[$3 + 1] = 'awaiting_admin', updated_at = now()
         FROM users AS app_user
         WHERE order_record.user_id = app_user.id AND app_user.telegram_id = $1
           AND order_record.id = $2 AND order_record.status = 'confirmed'
           AND $3 >= 0 AND $3 < cardinality(order_record.publication_dates)
           AND COALESCE(order_record.publication_dates[$3 + 1], '') <> ''
           AND order_record.publication_dates[$3 + 1] = $4
           AND COALESCE(order_record.publication_date_statuses[$3 + 1], 'awaiting_admin') = 'awaiting_user'
         RETURNING order_record.order_number, order_record.publication_dates[$3 + 1] AS publication_date
       )
       SELECT requested.order_number::text, $3 + 1 AS publication_number, requested.publication_date,
         ARRAY(SELECT telegram_id::text FROM admins WHERE is_active = true ORDER BY telegram_id) AS admin_telegram_ids
       FROM requested`,
      [telegramId, orderId, publicationIndex, expectedDate],
    );
    const row = result.rows[0];
    return row ? {
      orderNumber: row.order_number,
      publicationNumber: row.publication_number,
      date: row.publication_date,
      adminTelegramIds: row.admin_telegram_ids,
    } : undefined;
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

  async claimDuePaymentCheckoutReminders(): Promise<Array<{ orderId: string; orderNumber: string; telegramId: string }>> {
    const result = await this.database.query<{
      order_id: string;
      order_number: string;
      telegram_id: string;
    }>(
      `WITH due AS (
         SELECT reminder.order_id
         FROM payment_checkout_reminders AS reminder
         JOIN orders AS order_record ON order_record.id = reminder.order_id
         WHERE reminder.due_at <= now() AND reminder.sent_at IS NULL
           AND (reminder.claimed_at IS NULL OR reminder.claimed_at < now() - interval '10 minutes')
           AND order_record.status = 'confirmed'
           AND NOT EXISTS (SELECT 1 FROM payments WHERE payments.order_id = order_record.id AND payments.status <> 'rejected')
           AND NOT EXISTS (SELECT 1 FROM payment_method_requests AS request
             WHERE request.order_id = order_record.id AND request.status = 'pending')
         ORDER BY reminder.due_at ASC LIMIT 25 FOR UPDATE OF reminder SKIP LOCKED
       )
       UPDATE payment_checkout_reminders AS reminder SET claimed_at = now(), updated_at = now()
       FROM due, orders AS order_record, users AS app_user
       WHERE reminder.order_id = due.order_id AND order_record.id = reminder.order_id
         AND app_user.id = order_record.user_id
       RETURNING reminder.order_id, order_record.order_number::text, app_user.telegram_id::text`,
    );
    return result.rows.map((row) => ({
      orderId: row.order_id,
      orderNumber: row.order_number,
      telegramId: row.telegram_id,
    }));
  }

  async markPaymentCheckoutReminderSent(orderId: string): Promise<void> {
    await this.database.query(
      `UPDATE payment_checkout_reminders SET sent_at = now(), claimed_at = NULL, updated_at = now()
       WHERE order_id = $1 AND sent_at IS NULL`,
      [orderId],
    );
  }

  async releasePaymentCheckoutReminder(orderId: string): Promise<void> {
    await this.database.query(
      `UPDATE payment_checkout_reminders SET claimed_at = NULL, updated_at = now()
       WHERE order_id = $1 AND sent_at IS NULL`,
      [orderId],
    );
  }

  async cancelPaymentCheckoutReminder(orderId: string, telegramId: string): Promise<void> {
    await this.database.query(
      `UPDATE payment_checkout_reminders AS reminder SET sent_at = COALESCE(reminder.sent_at, now()),
         claimed_at = NULL, updated_at = now()
       FROM orders AS order_record, users AS app_user
       WHERE reminder.order_id = order_record.id AND order_record.user_id = app_user.id
         AND reminder.order_id = $1 AND app_user.telegram_id = $2`,
      [orderId, telegramId],
    );
  }

  async cancelDraft(telegramId: string): Promise<boolean> {
    const result = await this.database.query(
      `DELETE FROM order_drafts WHERE user_id = (SELECT id FROM users WHERE telegram_id = $1)`,
      [telegramId],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async createOrder(telegramId: string): Promise<CreatedOrder | undefined> {
    const client = await this.database.connect();
    try {
      await client.query('BEGIN');
      const draft = await client.query<{ user_id: string; business_id: string; tariff_id: string; preferred_date: string | null; publication_dates: string[]; status: string }>(
        `SELECT draft.user_id, draft.business_id, draft.tariff_id, draft.preferred_date, draft.publication_dates, draft.status
         FROM order_drafts AS draft
         JOIN users AS app_user ON app_user.id = draft.user_id
         WHERE app_user.telegram_id = $1
         FOR UPDATE OF draft`,
        [telegramId],
      );
      const current = draft.rows[0];
      if (!current || current.status !== 'ready') {
        await client.query('ROLLBACK');
        return undefined;
      }

      const inserted = await client.query<{
        id: string;
        order_number: string;
        price: string;
        discount_amount: string;
        currency: string;
      }>(
        `INSERT INTO orders (
           user_id, business_id, tariff_id, status, tariff_name_snapshot,
           tariff_description_snapshot, price, price_before_discount, discount_amount,
           currency, user_comment, publication_dates, publication_date_statuses, publication_statuses,
           publication_published_at, publication_links, feedback_delay_days_snapshot
         )
         SELECT draft.user_id, draft.business_id, tariff.id, 'pending_confirmation', tariff.name,
           COALESCE(NULLIF(CONCAT_WS(E'\\n',
             CASE WHEN NULLIF(BTRIM(tariff.platforms), '') IS NOT NULL THEN 'Площадки: ' || tariff.platforms END,
             CASE WHEN NULLIF(BTRIM(tariff.inclusions), '') IS NOT NULL THEN 'Включено: ' || tariff.inclusions END,
             CASE WHEN tariff.publication_count IS NOT NULL THEN 'Публикаций: ' || tariff.publication_count::text END,
             CASE WHEN NULLIF(BTRIM(tariff.placement_duration), '') IS NOT NULL THEN 'Срок размещения: ' || tariff.placement_duration END,
             NULLIF(BTRIM(tariff.description), '')
           ), ''), 'Условия размещения уточняются.'),
           CASE WHEN NOT EXISTS (
             SELECT 1 FROM orders AS previous
             WHERE previous.user_id = draft.user_id AND previous.status NOT IN ('rejected', 'cancelled')
           ) AND tariff.discount_valid_until >= CURRENT_DATE
             THEN (tariff.price * 0.9)::numeric(12,2) ELSE tariff.price END,
           tariff.price,
           CASE WHEN NOT EXISTS (
             SELECT 1 FROM orders AS previous
             WHERE previous.user_id = draft.user_id AND previous.status NOT IN ('rejected', 'cancelled')
           ) AND tariff.discount_valid_until >= CURRENT_DATE
             THEN (tariff.price * 0.1)::numeric(12,2) ELSE 0 END,
           tariff.currency,
           NULL,
           ARRAY(
             SELECT publication_date.value
             FROM unnest(draft.publication_dates) WITH ORDINALITY AS publication_date(value, position)
             ORDER BY CASE WHEN publication_date.value = '' THEN 1 ELSE 0 END,
               publication_date.value, publication_date.position
           ),
           ARRAY(
             SELECT CASE WHEN publication_date.value = '' THEN 'awaiting_admin'::text ELSE 'confirmed'::text END
             FROM unnest(draft.publication_dates) WITH ORDINALITY AS publication_date(value, position)
             ORDER BY CASE WHEN publication_date.value = '' THEN 1 ELSE 0 END,
               publication_date.value, publication_date.position
           ),
           ARRAY(SELECT 'pending'::text FROM generate_series(1, cardinality(draft.publication_dates))),
           ARRAY(SELECT NULL::timestamptz FROM generate_series(1, cardinality(draft.publication_dates))),
           ARRAY(SELECT NULL::text FROM generate_series(1, cardinality(draft.publication_dates))),
           tariff.feedback_delay_days
         FROM order_drafts AS draft
         JOIN users AS app_user ON app_user.id = draft.user_id
         JOIN tariffs AS tariff ON tariff.id = draft.tariff_id AND tariff.is_active = true
         WHERE app_user.telegram_id = $1 AND draft.status = 'ready'
         RETURNING id, order_number::text, price::text, discount_amount::text, currency`,
        [telegramId],
      );
      const order = inserted.rows[0];
      if (!order) {
        await client.query('ROLLBACK');
        return undefined;
      }

      await client.query('DELETE FROM order_drafts WHERE user_id = $1', [current.user_id]);
      await client.query('COMMIT');
      const admins = await this.database.query<{ telegram_id: string }>(
        `SELECT telegram_id::text FROM admins WHERE is_active = true`,
      );
      return {
        id: order.id,
        orderNumber: order.order_number,
        price: order.price,
        discountAmount: order.discount_amount,
        currency: order.currency,
        adminTelegramIds: admins.rows.map((row) => row.telegram_id),
      };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async beginPaymentProof(orderId: string, telegramId: string, paymentMethod: string): Promise<PaymentProofStart> {
    const client = await this.database.connect();
    try {
      await client.query('BEGIN');
      const order = await client.query<{ order_number: string }>(
        `SELECT order_record.order_number::text
         FROM orders AS order_record
         JOIN users AS app_user ON app_user.id = order_record.user_id
         WHERE order_record.id = $1 AND app_user.telegram_id = $2 AND order_record.status = 'confirmed'
         FOR UPDATE OF order_record`,
        [orderId, telegramId],
      );
      if (!order.rows[0]) {
        await client.query('ROLLBACK');
        return { kind: 'not_confirmed' };
      }

      const existing = await client.query<{ status: string }>(
        `SELECT status FROM payments WHERE order_id = $1 FOR UPDATE`,
        [orderId],
      );
      if (existing.rows[0] && existing.rows[0].status !== 'rejected') {
        await client.query('COMMIT');
        return { kind: 'already_reported', orderNumber: order.rows[0].order_number };
      }

      await client.query(
        `DELETE FROM payment_proof_requests AS request
         USING orders AS previous_order
         WHERE request.order_id = previous_order.id AND previous_order.user_id = (
           SELECT id FROM users WHERE telegram_id = $2
         ) AND request.order_id <> $1`,
        [orderId, telegramId],
      );
      await client.query(
        `INSERT INTO payment_proof_requests (order_id, payment_method)
         VALUES ($1, $2)
         ON CONFLICT (order_id) DO UPDATE SET payment_method = EXCLUDED.payment_method, created_at = now()`,
        [orderId, paymentMethod],
      );
      await client.query('COMMIT');
      return { kind: 'started', orderNumber: order.rows[0].order_number };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async pendingPaymentProof(telegramId: string): Promise<PaymentProofRequest | undefined> {
    const result = await this.database.query<{
      order_id: string;
      order_number: string;
      payment_method: string;
    }>(
      `SELECT request.order_id, order_record.order_number::text, request.payment_method
       FROM payment_proof_requests AS request
       JOIN orders AS order_record ON order_record.id = request.order_id
       JOIN users AS app_user ON app_user.id = order_record.user_id
       WHERE app_user.telegram_id = $1
       ORDER BY request.created_at DESC LIMIT 1`,
      [telegramId],
    );
    const row = result.rows[0];
    return row ? { orderId: row.order_id, orderNumber: row.order_number, paymentMethod: row.payment_method } : undefined;
  }

  async cancelPaymentProof(orderId: string, telegramId: string): Promise<void> {
    await this.database.query(
      `DELETE FROM payment_proof_requests AS request
       USING orders AS order_record, users AS app_user
       WHERE request.order_id = order_record.id AND order_record.user_id = app_user.id
         AND request.order_id = $1 AND app_user.telegram_id = $2`,
      [orderId, telegramId],
    );
  }

  async reportPayment(orderId: string, telegramId: string, paymentMethod: string, proofFileId?: string): Promise<PaymentReport> {
    const result = await this.database.query<{ order_id: string }>(
      `INSERT INTO payments (order_id, amount, currency, payment_method, proof_file_id)
       SELECT order_record.id, order_record.price, order_record.currency, $3, $4
       FROM orders AS order_record
       JOIN users AS app_user ON app_user.id = order_record.user_id
       WHERE order_record.id = $1 AND app_user.telegram_id = $2 AND order_record.status = 'confirmed'
       ON CONFLICT (order_id) DO UPDATE
       SET status = 'pending_approval', user_reported_at = now(), payment_method = EXCLUDED.payment_method,
           proof_file_id = EXCLUDED.proof_file_id,
           reviewed_by_admin_id = NULL, reviewed_at = NULL, admin_comment = NULL, updated_at = now()
       WHERE payments.status = 'rejected'
       RETURNING order_id`,
      [orderId, telegramId, paymentMethod, proofFileId ?? null],
    );
    if (result.rows[0]) {
      await this.cancelPaymentProof(orderId, telegramId);
      await this.cancelPaymentCheckoutReminder(orderId, telegramId);
      const order = await this.database.query<{ order_number: string; price: string; currency: string }>(
        `SELECT order_number::text, price::text, currency FROM orders WHERE id = $1`,
        [result.rows[0].order_id],
      );
      const admins = await this.database.query<{ telegram_id: string }>(
        `SELECT telegram_id::text FROM admins WHERE is_active = true`,
      );
      const reportedOrder = order.rows[0];
      if (!reportedOrder) return { kind: 'not_confirmed' };
      return {
        kind: 'created',
        orderNumber: reportedOrder.order_number,
        amount: reportedOrder.price,
        currency: reportedOrder.currency,
        paymentMethod,
        adminTelegramIds: admins.rows.map((row) => row.telegram_id),
      };
    }

    const existing = await this.database.query<{ order_number: string; status: string }>(
      `SELECT order_record.order_number::text, order_record.status
       FROM orders AS order_record
       JOIN users AS app_user ON app_user.id = order_record.user_id
       WHERE order_record.id = $1 AND app_user.telegram_id = $2
         AND EXISTS (SELECT 1 FROM payments WHERE order_id = order_record.id)`,
      [orderId, telegramId],
    );
    if (existing.rows[0]) return { kind: 'already_reported', orderNumber: existing.rows[0].order_number };
    return { kind: 'not_confirmed' };
  }
}
