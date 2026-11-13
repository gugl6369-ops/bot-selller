import type { Pool } from 'pg';
import type { AdminFeedback, AdminFeedbackMessage, AdminInboxCounts, AdminPayment, ReviewedPayment } from '../../../types/admin.ts';
import { DATA_DELETION_INQUIRY_TOPIC } from '../../../services/inquiry-topics.ts';
export class AdminInboxRepository {
  private readonly database: Pool;

  constructor(database: Pool) {
    this.database = database;
  }

  async getInboxCounts(): Promise<AdminInboxCounts> {
    const result = await this.database.query<{
      unanswered_questions: string;
      data_deletion_requests: string;
      pending_orders: string;
      pending_payments: string;
      pending_materials: string;
      feedbacks: string;
    }>(
      `SELECT (SELECT COUNT(*)::text FROM inquiries WHERE topic <> $1) AS unanswered_questions,
         (SELECT COUNT(*)::text FROM inquiries WHERE topic = $1) AS data_deletion_requests,
         (SELECT COUNT(*)::text FROM orders WHERE status = 'pending_confirmation') AS pending_orders,
         (SELECT COUNT(*)::text FROM payments WHERE status = 'pending_approval') AS pending_payments,
         (SELECT COUNT(*)::text FROM order_material_submissions AS material
           JOIN orders AS order_record ON order_record.id = material.order_id
           WHERE (material.status = 'submitted' AND order_record.status <> 'completed') OR
             (material.status = 'approved' AND material.reused_from_order_id IS NOT NULL
               AND material.submitted_at >= now() - interval '24 hours')) AS pending_materials,
         (SELECT COUNT(*)::text FROM order_feedback
           WHERE created_at >= now() - interval '24 hours') AS feedbacks`,
      [DATA_DELETION_INQUIRY_TOPIC],
    );
    return {
      unansweredQuestions: Number(result.rows[0]?.unanswered_questions ?? 0),
      dataDeletionRequests: Number(result.rows[0]?.data_deletion_requests ?? 0),
      pendingOrders: Number(result.rows[0]?.pending_orders ?? 0),
      pendingPayments: Number(result.rows[0]?.pending_payments ?? 0),
      pendingMaterials: Number(result.rows[0]?.pending_materials ?? 0),
      feedbacks: Number(result.rows[0]?.feedbacks ?? 0),
    };
  }

  async getFeedbackCounts(): Promise<{ total: number; positive: number; discussions: number }> {
    const result = await this.database.query<{ total: string; positive: string; discussions: string }>(
      `SELECT COUNT(*)::text AS total,
         COUNT(*) FILTER (WHERE feedback.response = 'good')::text AS positive,
         COUNT(*) FILTER (WHERE feedback.response = 'discuss')::text AS discussions
       FROM order_feedback AS feedback`,
    );
    return {
      total: Number(result.rows[0]?.total ?? 0),
      positive: Number(result.rows[0]?.positive ?? 0),
      discussions: Number(result.rows[0]?.discussions ?? 0),
    };
  }

  async listFeedback(filter: 'all' | 'positive' | 'discussions' = 'all', recentOnly = false): Promise<AdminFeedback[]> {
    const result = await this.database.query<{
      order_id: string; order_number: string; telegram_id: string; first_name: string; username: string | null;
      business_name: string; tariff_name: string; response: 'good' | 'discuss' | 'repeat'; review_text: string | null;
      status: 'open' | 'closed'; created_at: Date;
    }>(
      `SELECT feedback.order_id, order_record.order_number::text, app_user.telegram_id::text,
         app_user.first_name, app_user.username, business.name AS business_name,
         order_record.tariff_name_snapshot AS tariff_name, feedback.response, feedback.review_text,
         feedback.status, feedback.created_at
       FROM order_feedback AS feedback
       JOIN orders AS order_record ON order_record.id = feedback.order_id
       JOIN users AS app_user ON app_user.id = feedback.user_id
       JOIN businesses AS business ON business.id = order_record.business_id
       WHERE ($1 = 'all' OR ($1 = 'positive' AND feedback.response = 'good')
         OR ($1 = 'discussions' AND feedback.response = 'discuss'))
         AND ($2 = false OR feedback.created_at >= now() - interval '24 hours')
       ORDER BY feedback.created_at DESC LIMIT 50`,
      [filter, recentOnly],
    );
    return result.rows.map((row) => ({
      orderId: row.order_id,
      orderNumber: row.order_number,
      telegramId: row.telegram_id,
      firstName: row.first_name,
      username: row.username,
      businessName: row.business_name,
      tariffName: row.tariff_name,
      response: row.response,
      reviewText: row.review_text,
      status: row.status,
      createdAt: row.created_at.toISOString(),
    }));
  }

  async getFeedback(orderId: string): Promise<AdminFeedback | undefined> {
    const result = await this.database.query<{
      order_id: string; order_number: string; telegram_id: string; first_name: string; username: string | null;
      business_name: string; tariff_name: string; response: 'good' | 'discuss' | 'repeat'; review_text: string | null;
      status: 'open' | 'closed'; created_at: Date;
    }>(
      `SELECT feedback.order_id, order_record.order_number::text, app_user.telegram_id::text,
         app_user.first_name, app_user.username, business.name AS business_name,
         order_record.tariff_name_snapshot AS tariff_name, feedback.response, feedback.review_text,
         feedback.status, feedback.created_at
       FROM order_feedback AS feedback
       JOIN orders AS order_record ON order_record.id = feedback.order_id
       JOIN users AS app_user ON app_user.id = feedback.user_id
       JOIN businesses AS business ON business.id = order_record.business_id
       WHERE feedback.order_id = $1`,
      [orderId],
    );
    const row = result.rows[0];
    return row ? {
      orderId: row.order_id,
      orderNumber: row.order_number,
      telegramId: row.telegram_id,
      firstName: row.first_name,
      username: row.username,
      businessName: row.business_name,
      tariffName: row.tariff_name,
      response: row.response,
      reviewText: row.review_text,
      status: row.status,
      createdAt: row.created_at.toISOString(),
    } : undefined;
  }

  async listFeedbackMessages(orderId: string): Promise<AdminFeedbackMessage[]> {
    const result = await this.database.query<{ sender_type: 'user' | 'admin'; message: string; created_at: Date }>(
      `SELECT sender_type, message, created_at FROM order_feedback_messages
       WHERE order_id = $1 ORDER BY created_at ASC`,
      [orderId],
    );
    return result.rows.map((row) => ({
      senderType: row.sender_type,
      message: row.message,
      createdAt: row.created_at.toISOString(),
    }));
  }

  async startFeedbackInput(
    telegramId: string,
    orderId: string,
    senderType: 'user' | 'admin',
    mode: 'review' | 'message',
  ): Promise<boolean> {
    const result = await this.database.query(
      `INSERT INTO feedback_reply_sessions (telegram_id, order_id, sender_type, mode)
       SELECT $1, feedback.order_id, $3, $4
       FROM order_feedback AS feedback
       JOIN orders AS order_record ON order_record.id = feedback.order_id
       LEFT JOIN users AS app_user ON app_user.id = feedback.user_id
       WHERE feedback.order_id = $2 AND order_record.status = 'completed'
         AND ($3 = 'admin' OR app_user.telegram_id = $1)
         AND ($4 <> 'review' OR feedback.review_text IS NULL)
       ON CONFLICT (telegram_id) DO UPDATE
         SET order_id = EXCLUDED.order_id, sender_type = EXCLUDED.sender_type,
             mode = EXCLUDED.mode, created_at = now()
       RETURNING telegram_id`,
      [telegramId, orderId, senderType, mode],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async hasFeedbackInput(telegramId: string): Promise<boolean> {
    const result = await this.database.query<{ active: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM feedback_reply_sessions WHERE telegram_id = $1) AS active`,
      [telegramId],
    );
    return result.rows[0]?.active ?? false;
  }

  async cancelFeedbackInput(telegramId: string): Promise<void> {
    await this.database.query(`DELETE FROM feedback_reply_sessions WHERE telegram_id = $1`, [telegramId]);
  }

  async completeFeedbackInput(telegramId: string, message: string): Promise<{
    orderId: string; orderNumber: string; userTelegramId: string; userName: string; businessName: string;
    tariffName: string; senderType: 'user' | 'admin'; mode: 'review' | 'message';
    adminTelegramIds: string[]; reviewSaved: boolean; response: 'good' | 'discuss' | 'repeat';
  } | undefined> {
    const client = await this.database.connect();
    try {
      await client.query('BEGIN');
      const sessionResult = await client.query<{
        order_id: string; sender_type: 'user' | 'admin'; mode: 'review' | 'message'; response: 'good' | 'discuss' | 'repeat'; order_number: string;
        user_telegram_id: string; first_name: string; username: string | null; business_name: string; tariff_name: string;
      }>(
        `SELECT session.order_id, session.sender_type, session.mode, feedback.response, order_record.order_number::text,
           app_user.telegram_id::text AS user_telegram_id, app_user.first_name, app_user.username,
           business.name AS business_name, order_record.tariff_name_snapshot AS tariff_name
         FROM feedback_reply_sessions AS session
         JOIN order_feedback AS feedback ON feedback.order_id = session.order_id
         JOIN orders AS order_record ON order_record.id = session.order_id
         JOIN users AS app_user ON app_user.id = feedback.user_id
         JOIN businesses AS business ON business.id = order_record.business_id
         WHERE session.telegram_id = $1 AND order_record.status = 'completed'
         FOR UPDATE OF session, feedback`,
        [telegramId],
      );
      const session = sessionResult.rows[0];
      if (!session) {
        await client.query('ROLLBACK');
        return undefined;
      }

      let reviewSaved = false;
      if (session.mode === 'review' && session.sender_type === 'user') {
        const saved = await client.query(
          `UPDATE order_feedback SET review_text = $2, updated_at = now()
           WHERE order_id = $1 AND review_text IS NULL`,
          [session.order_id, message],
        );
        reviewSaved = (saved.rowCount ?? 0) > 0;
        if (!reviewSaved) {
          await client.query('DELETE FROM feedback_reply_sessions WHERE telegram_id = $1', [telegramId]);
          await client.query('COMMIT');
          return undefined;
        }
      } else {
        await client.query(
          `INSERT INTO order_feedback_messages (order_id, sender_type, sender_telegram_id, message)
           VALUES ($1, $2, $3, $4)`,
          [session.order_id, session.sender_type, telegramId, message],
        );
        if (session.sender_type === 'user') {
          await client.query(`UPDATE order_feedback SET status = 'open', updated_at = now() WHERE order_id = $1`, [session.order_id]);
        }
      }
      await client.query('DELETE FROM feedback_reply_sessions WHERE telegram_id = $1', [telegramId]);
      const admins = session.sender_type === 'user'
        ? await client.query<{ telegram_id: string }>('SELECT telegram_id::text FROM admins WHERE is_active = true ORDER BY telegram_id')
        : { rows: [] as { telegram_id: string }[] };
      await client.query('COMMIT');
      return {
        orderId: session.order_id,
        orderNumber: session.order_number,
        userTelegramId: session.user_telegram_id,
        userName: `${session.first_name}${session.username ? ` (@${session.username})` : ''}`,
        businessName: session.business_name,
        tariffName: session.tariff_name,
        senderType: session.sender_type,
        mode: session.mode,
        adminTelegramIds: admins.rows.map((row) => row.telegram_id),
        reviewSaved,
        response: session.response,
      };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async setFeedbackStatus(orderId: string, status: 'open' | 'closed'): Promise<void> {
    await this.database.query(`UPDATE order_feedback SET status = $2, updated_at = now() WHERE order_id = $1`, [orderId, status]);
  }

  async getMaterialStatusCounts(): Promise<{ submitted: number; approved: number }> {
    const result = await this.database.query<{ submitted: string; approved: string }>(
      `SELECT
         COUNT(*) FILTER (WHERE material.status = 'submitted')::text AS submitted,
         COUNT(*) FILTER (WHERE material.status = 'approved')::text AS approved
       FROM order_material_submissions AS material
       JOIN orders AS order_record ON order_record.id = material.order_id
       WHERE material.status IN ('submitted', 'approved') AND order_record.status <> 'completed'`,
    );
    return {
      submitted: Number(result.rows[0]?.submitted ?? 0),
      approved: Number(result.rows[0]?.approved ?? 0),
    };
  }

  async getInboxMessageId(telegramId: string): Promise<number | undefined> {
    const result = await this.database.query<{ message_id: number }>(
      `SELECT inbox.message_id
       FROM admin_inbox_messages AS inbox
       JOIN admins AS admin ON admin.id = inbox.admin_id
       WHERE admin.telegram_id = $1 AND admin.is_active = true`,
      [telegramId],
    );
    return result.rows[0]?.message_id;
  }

  async saveInboxMessageId(telegramId: string, messageId: number): Promise<void> {
    await this.database.query(
      `INSERT INTO admin_inbox_messages (admin_id, message_id)
       SELECT id, $2 FROM admins WHERE telegram_id = $1 AND is_active = true
       ON CONFLICT (admin_id) DO UPDATE
       SET message_id = EXCLUDED.message_id, updated_at = now()`,
      [telegramId, messageId],
    );
  }

  async listPendingPayments(): Promise<AdminPayment[]> {
    const result = await this.database.query<{
      id: string;
      order_number: string;
      telegram_id: string;
      first_name: string;
      username: string | null;
      business_name: string | null;
      amount: string;
      currency: string;
      payment_method: string;
      publication_dates: string[];
      proof_file_id: string | null;
      user_reported_at: Date;
    }>(
      `SELECT payment.id, order_record.order_number::text, app_user.telegram_id::text,
         app_user.first_name, app_user.username, business.name AS business_name,
         payment.amount::text, payment.currency, payment.payment_method, order_record.publication_dates,
         payment.proof_file_id, payment.user_reported_at
       FROM payments AS payment
       JOIN orders AS order_record ON order_record.id = payment.order_id
       JOIN users AS app_user ON app_user.id = order_record.user_id
       LEFT JOIN businesses AS business ON business.id = order_record.business_id
       WHERE payment.status = 'pending_approval'
       ORDER BY payment.user_reported_at ASC LIMIT 20`,
    );
    return result.rows.map((row) => ({
      id: row.id,
      orderNumber: row.order_number,
      telegramId: row.telegram_id,
      firstName: row.first_name,
      username: row.username,
      businessName: row.business_name,
      amount: row.amount,
      currency: row.currency,
      paymentMethod: row.payment_method,
      publicationDates: row.publication_dates,
      proofFileId: row.proof_file_id,
      reportedAt: row.user_reported_at.toISOString(),
    }));
  }

  async reviewPayment(paymentId: string, adminTelegramId: string, approved: boolean): Promise<ReviewedPayment | undefined> {
    const client = await this.database.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query<ReviewedPayment>(
        `UPDATE payments AS payment SET status = $3,
           reviewed_by_admin_id = (SELECT id FROM admins WHERE telegram_id = $2 AND is_active = true),
           reviewed_at = now(), updated_at = now()
         FROM orders AS order_record
         JOIN users AS app_user ON app_user.id = order_record.user_id
         LEFT JOIN businesses AS business ON business.id = order_record.business_id
         WHERE payment.order_id = order_record.id AND payment.id = $1 AND payment.status = 'pending_approval'
         RETURNING order_record.id AS "orderId", app_user.telegram_id::text AS "telegramId",
           order_record.order_number::text AS "orderNumber", app_user.first_name AS "firstName",
           app_user.username, business.name AS "businessName"`,
        [paymentId, adminTelegramId, approved ? 'approved' : 'rejected'],
      );
      const reviewed = result.rows[0];
      if (!reviewed || !approved) {
        await client.query('COMMIT');
        return reviewed;
      }

      const award = await client.query<{
        referrer_user_id: string;
        amount: string;
        currency: string;
        expires_at: Date | null;
      }>(
        `INSERT INTO referral_bonuses (
           referrer_user_id, invited_user_id, order_id, amount, currency, expires_at, note
         )
         SELECT invited.referred_by_user_id, invited.id, order_record.id,
           settings.bonus_amount, settings.currency,
           CASE WHEN settings.validity_days IS NULL THEN NULL
             ELSE now() + (settings.validity_days * interval '1 day') END,
           CASE WHEN settings.combine_with_first_discount
             THEN 'Начислено после первой подтверждённой оплаты; можно совмещать со скидкой'
             ELSE 'Начислено после первой подтверждённой оплаты; без совмещения со скидкой' END
         FROM orders AS order_record
         JOIN users AS invited ON invited.id = order_record.user_id
         JOIN payments AS payment ON payment.order_id = order_record.id AND payment.status = 'approved'
         CROSS JOIN referral_program_settings AS settings
         WHERE order_record.id = $1 AND invited.referred_by_user_id IS NOT NULL
           AND settings.singleton = true AND settings.is_active = true AND settings.bonus_amount > 0
           AND (settings.eligible_tariff_ids IS NULL OR order_record.tariff_id = ANY(settings.eligible_tariff_ids))
           AND NOT EXISTS (
             SELECT 1 FROM payments AS earlier_payment
             JOIN orders AS earlier_order ON earlier_order.id = earlier_payment.order_id
             WHERE earlier_order.user_id = invited.id AND earlier_payment.status = 'approved'
               AND earlier_order.id <> order_record.id
           )
         ON CONFLICT (invited_user_id) WHERE order_id IS NOT NULL DO NOTHING
         RETURNING referrer_user_id, amount::text, currency, expires_at`,
        [reviewed.orderId],
      );
      const bonus = award.rows[0];
      if (bonus) {
        const referrer = await client.query<{ telegram_id: string }>(
          'SELECT telegram_id::text FROM users WHERE id = $1',
          [bonus.referrer_user_id],
        );
        if (referrer.rows[0]) {
          reviewed.referralBonus = {
            referrerTelegramId: referrer.rows[0].telegram_id,
            amount: bonus.amount,
            currency: bonus.currency.trim(),
            expiresAt: bonus.expires_at?.toISOString() ?? null,
          };
        }
      }
      await client.query('COMMIT');
      return reviewed;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}
