import type { Pool } from 'pg';
import type { AdminOrder, AdminMaterialSubmission } from '../../../types/admin.ts';
import type { OrderMaterialMedia } from '../../../types/order-material.ts';
export class AdminOrderRepository {
  private readonly database: Pool;

  constructor(database: Pool) {
    this.database = database;
  }

  async listOrders(status: string | null = null): Promise<AdminOrder[]> {
    const result = await this.database.query<{
      id: string;
      order_number: string;
      telegram_id: string;
      first_name: string;
      username: string | null;
      business_name: string;
      tariff_name: string;
      status: string;
      price: string;
      currency: string;
      publication_at: Date | null;
      publication_dates: string[];
      publication_statuses: string[];
      reused_materials_from_order_number: string | null;
    }>(
      `SELECT order_record.id, order_record.order_number::text, app_user.telegram_id::text,
         app_user.first_name, app_user.username, business.name AS business_name, order_record.tariff_name_snapshot AS tariff_name,
         order_record.status, order_record.price::text, order_record.currency, order_record.publication_at,
         order_record.publication_dates, order_record.publication_statuses,
         reused_order.order_number::text AS reused_materials_from_order_number
       FROM orders AS order_record
       JOIN users AS app_user ON app_user.id = order_record.user_id
       JOIN businesses AS business ON business.id = order_record.business_id
       LEFT JOIN order_material_submissions AS material ON material.order_id = order_record.id
       LEFT JOIN orders AS reused_order ON reused_order.id = material.reused_from_order_id
       WHERE ($1::text IS NULL OR order_record.status = $1)
       ORDER BY order_record.created_at DESC LIMIT 20`,
      [status],
    );
    return result.rows.map((row) => ({
      id: row.id,
      orderNumber: row.order_number,
      telegramId: row.telegram_id,
      firstName: row.first_name,
      username: row.username,
      businessName: row.business_name,
      tariffName: row.tariff_name,
      status: row.status,
      price: row.price,
      currency: row.currency,
      publicationAt: row.publication_at?.toISOString() ?? null,
      publicationDates: row.publication_dates,
      publicationStatuses: row.publication_statuses,
      reusedMaterialsFromOrderNumber: row.reused_materials_from_order_number,
    }));
  }

  async getOrderStatusCounts(): Promise<{
    pendingConfirmation: number;
    confirmed: number;
    rejected: number;
    cancelled: number;
    completed: number;
    total: number;
  }> {
    const result = await this.database.query<{
      pending_confirmation: string;
      confirmed: string;
      rejected: string;
      cancelled: string;
      completed: string;
      total: string;
    }>(
      `SELECT
         COUNT(*) FILTER (WHERE status = 'pending_confirmation')::text AS pending_confirmation,
         COUNT(*) FILTER (WHERE status = 'confirmed')::text AS confirmed,
         COUNT(*) FILTER (WHERE status = 'rejected')::text AS rejected,
         COUNT(*) FILTER (WHERE status = 'cancelled')::text AS cancelled,
         COUNT(*) FILTER (WHERE status = 'completed')::text AS completed,
         COUNT(*)::text AS total
       FROM orders`,
    );
    const row = result.rows[0];
    return {
      pendingConfirmation: Number(row?.pending_confirmation ?? 0),
      confirmed: Number(row?.confirmed ?? 0),
      rejected: Number(row?.rejected ?? 0),
      cancelled: Number(row?.cancelled ?? 0),
      completed: Number(row?.completed ?? 0),
      total: Number(row?.total ?? 0),
    };
  }

  async listMaterialSubmissions(
    includeApproved = false,
    statusFilter?: 'submitted' | 'approved',
  ): Promise<AdminMaterialSubmission[]> {
    const statusCondition = statusFilter
      ? `material.status = '${statusFilter}'`
      : includeApproved
        ? "material.status IN ('submitted', 'approved')"
        : "(material.status = 'submitted' OR (material.status = 'approved' AND material.reused_from_order_id IS NOT NULL AND material.submitted_at >= now() - interval '24 hours'))";
    const result = await this.database.query<{
      order_id: string;
      order_number: string;
      status: 'submitted' | 'approved';
      telegram_id: string;
      first_name: string;
      username: string | null;
      business_name: string;
      tariff_name_snapshot: string;
      ad_text: string;
      media: OrderMaterialMedia[];
      destination: string;
      publication_dates: string[];
      publication_statuses: string[];
      wishes: string;
      submitted_at: Date;
      reused_from_order_number: string | null;
    }>(
      `SELECT order_record.id AS order_id, order_record.order_number::text, material.status,
         app_user.telegram_id::text, app_user.first_name, app_user.username, business.name AS business_name,
         order_record.tariff_name_snapshot, material.ad_text, material.media,
         material.destination, order_record.publication_dates, order_record.publication_statuses, material.wishes, material.submitted_at,
         source_order.order_number::text AS reused_from_order_number
       FROM order_material_submissions AS material
       JOIN orders AS order_record ON order_record.id = material.order_id
       LEFT JOIN orders AS source_order ON source_order.id = material.reused_from_order_id
       JOIN users AS app_user ON app_user.id = order_record.user_id
       JOIN businesses AS business ON business.id = order_record.business_id
       WHERE (${statusCondition}) AND (order_record.status <> 'completed' OR
         (material.status = 'approved' AND material.reused_from_order_id IS NOT NULL AND material.submitted_at >= now() - interval '24 hours'))
       ORDER BY material.submitted_at DESC LIMIT 30`,
    );
    return result.rows.map((row) => ({
      orderId: row.order_id,
      orderNumber: row.order_number,
      status: row.status,
      telegramId: row.telegram_id,
      firstName: row.first_name,
      username: row.username,
      businessName: row.business_name,
      tariffName: row.tariff_name_snapshot,
      adText: row.ad_text,
      media: row.media,
      destination: row.destination,
      publicationDates: row.publication_dates,
      publicationStatuses: row.publication_statuses,
      wishes: row.wishes,
      submittedAt: row.submitted_at.toISOString(),
      reusedFromOrderNumber: row.reused_from_order_number,
    }));
  }

  async getMaterialSubmission(orderId: string, includeApproved = false): Promise<AdminMaterialSubmission | undefined> {
    const result = await this.database.query<{
      order_id: string;
      order_number: string;
      status: 'submitted' | 'approved';
      telegram_id: string;
      first_name: string;
      username: string | null;
      business_name: string;
      tariff_name_snapshot: string;
      ad_text: string;
      media: OrderMaterialMedia[];
      destination: string;
      publication_dates: string[];
      publication_statuses: string[];
      wishes: string;
      submitted_at: Date;
    }>(
      `SELECT order_record.id AS order_id, order_record.order_number::text, material.status,
         app_user.telegram_id::text, app_user.first_name, app_user.username, business.name AS business_name,
         order_record.tariff_name_snapshot, material.ad_text, material.media,
         material.destination, order_record.publication_dates, order_record.publication_statuses, material.wishes, material.submitted_at
       FROM order_material_submissions AS material
       JOIN orders AS order_record ON order_record.id = material.order_id
       JOIN users AS app_user ON app_user.id = order_record.user_id
       JOIN businesses AS business ON business.id = order_record.business_id
       WHERE material.order_id = $1 AND ${includeApproved ? "material.status IN ('submitted', 'approved')" : "material.status = 'submitted'"} AND order_record.status <> 'completed'`,
      [orderId],
    );
    const row = result.rows[0];
    return row ? {
      orderId: row.order_id,
      orderNumber: row.order_number,
      status: row.status,
      telegramId: row.telegram_id,
      firstName: row.first_name,
      username: row.username,
      businessName: row.business_name,
      tariffName: row.tariff_name_snapshot,
      adText: row.ad_text,
      media: row.media,
      destination: row.destination,
      publicationDates: row.publication_dates,
      publicationStatuses: row.publication_statuses,
      wishes: row.wishes,
      submittedAt: row.submitted_at.toISOString(),
    } : undefined;
  }

  async setMaterialStatus(orderId: string, status: 'approved' | 'rejected'): Promise<boolean> {
    const result = await this.database.query(
      `UPDATE order_material_submissions
       SET status = $2, updated_at = now()
       WHERE order_id = $1 AND status = 'submitted'`,
      [orderId, status],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async requestMaterialCorrections(orderId: string, comment: string): Promise<boolean> {
    const result = await this.database.query(
      `UPDATE order_material_submissions
       SET status = 'collecting', is_paused = false, step = 6, revision_mode = true, admin_comment = $2,
           submitted_at = NULL, updated_at = now()
       WHERE order_id = $1 AND status = 'submitted'`,
      [orderId, comment],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async changeOrderStatus(orderId: string, adminTelegramId: string, status: 'confirmed' | 'rejected' | 'cancelled' | 'completed'): Promise<{
    id: string;
    telegramId: string;
    orderNumber: string;
    firstName: string;
    username: string | null;
    businessName: string | null;
  } | undefined> {
    const result = await this.database.query<{
      id: string;
      telegram_id: string;
      order_number: string;
      first_name: string;
      username: string | null;
      business_name: string | null;
    }>(
      `UPDATE orders SET status = $3,
         confirmed_by_admin_id = CASE WHEN $3 IN ('confirmed', 'completed') THEN (SELECT id FROM admins WHERE telegram_id = $2) ELSE confirmed_by_admin_id END,
         confirmed_at = CASE WHEN $3 IN ('confirmed', 'completed') THEN COALESCE(confirmed_at, now()) ELSE confirmed_at END,
         rejected_by_admin_id = CASE WHEN $3 = 'rejected' THEN (SELECT id FROM admins WHERE telegram_id = $2) ELSE rejected_by_admin_id END,
         rejected_at = CASE WHEN $3 = 'rejected' THEN now() ELSE rejected_at END,
         updated_at = now()
       WHERE id = $1 AND status = $4
       RETURNING id, (SELECT telegram_id::text FROM users WHERE id = orders.user_id) AS telegram_id,
         order_number::text,
         (SELECT first_name FROM users WHERE id = orders.user_id) AS first_name,
         (SELECT username FROM users WHERE id = orders.user_id) AS username,
         (SELECT business.name FROM businesses AS business WHERE business.id = orders.business_id) AS business_name`,
      [orderId, adminTelegramId, status, status === 'completed' ? 'confirmed' : 'pending_confirmation'],
    );
    const row = result.rows[0];
    return row ? {
      id: row.id,
      telegramId: row.telegram_id,
      orderNumber: row.order_number,
      firstName: row.first_name,
      username: row.username,
      businessName: row.business_name,
    } : undefined;
  }

  async markOrderPublished(orderId: string, publicationIndex: number, publicationLink: string | null): Promise<{
    telegramId: string;
    orderNumber: string;
    businessName: string;
    publicationLink: string | null;
    publishedAt: string;
    publicationDate: string;
    publicationNumber: number;
    publicationCount: number;
    remainingPublications: number;
    allPublished: boolean;
    feedbackDueAt: string | null;
    feedbackDelayDays: number;
  } | undefined> {
    const result = await this.database.query<{
      telegram_id: string;
      order_number: string;
      business_name: string;
      publication_link: string | null;
      published_at: Date;
      publication_date: string;
      publication_number: number;
      publication_count: number;
      remaining_publications: number;
      all_published: boolean;
      feedback_due_at: Date | null;
      feedback_delay_days_snapshot: number;
    }>(
      `WITH candidate AS (
         SELECT order_record.id, order_record.order_number, order_record.user_id, order_record.business_id,
           order_record.publication_dates, order_record.publication_date_statuses, order_record.publication_statuses,
           order_record.publication_published_at, order_record.publication_links,
           order_record.feedback_delay_days_snapshot
         FROM orders AS order_record
         WHERE order_record.id = $1 AND order_record.status = 'confirmed' AND order_record.published_at IS NULL
         FOR UPDATE
       ), normalized AS (
         SELECT candidate.*,
           ARRAY(
             SELECT COALESCE(candidate.publication_statuses[series.position], 'pending')
             FROM generate_series(1, cardinality(candidate.publication_dates)) AS series(position)
             ORDER BY series.position
           ) AS current_statuses,
           ARRAY(
             SELECT COALESCE(candidate.publication_date_statuses[series.position],
               CASE WHEN candidate.publication_dates[series.position] = '' THEN 'awaiting_admin' ELSE 'confirmed' END)
             FROM generate_series(1, cardinality(candidate.publication_dates)) AS series(position)
             ORDER BY series.position
           ) AS current_date_statuses
         FROM candidate
       ), marked AS (
         SELECT normalized.*,
           ARRAY(
             SELECT CASE WHEN series.position = $2 + 1 THEN 'published'::text ELSE normalized.current_statuses[series.position] END
             FROM generate_series(1, cardinality(normalized.publication_dates)) AS series(position)
             ORDER BY series.position
           ) AS next_statuses,
           ARRAY(
             SELECT CASE WHEN series.position = $2 + 1 THEN now() ELSE normalized.publication_published_at[series.position] END
             FROM generate_series(1, cardinality(normalized.publication_dates)) AS series(position)
             ORDER BY series.position
           ) AS next_published_at,
           ARRAY(
             SELECT CASE WHEN series.position = $2 + 1 THEN $3::text ELSE normalized.publication_links[series.position] END
             FROM generate_series(1, cardinality(normalized.publication_dates)) AS series(position)
             ORDER BY series.position
           ) AS next_links
         FROM normalized
         WHERE $2 >= 0 AND $2 < cardinality(normalized.publication_dates)
           AND normalized.current_statuses[$2 + 1] <> 'published'
           AND COALESCE(normalized.publication_dates[$2 + 1], '') <> ''
           AND normalized.current_date_statuses[$2 + 1] = 'confirmed'
       )
       UPDATE orders AS order_record SET
         publication_statuses = marked.next_statuses,
         publication_published_at = marked.next_published_at,
         publication_links = marked.next_links,
         status = CASE WHEN 'pending' = ANY(marked.next_statuses) THEN order_record.status ELSE 'completed' END,
         published_at = CASE WHEN 'pending' = ANY(marked.next_statuses) THEN NULL ELSE now() END,
         publication_link = CASE WHEN 'pending' = ANY(marked.next_statuses) THEN order_record.publication_link ELSE $3 END,
         feedback_due_at = CASE WHEN 'pending' = ANY(marked.next_statuses) THEN NULL
           ELSE now() + (marked.feedback_delay_days_snapshot * interval '1 day') END,
         feedback_sent_at = NULL, feedback_claimed_at = NULL, feedback_response = NULL, updated_at = now()
       FROM marked
       WHERE order_record.id = marked.id
       RETURNING (SELECT app_user.telegram_id::text FROM users AS app_user WHERE app_user.id = order_record.user_id) AS telegram_id,
         marked.order_number::text,
         (SELECT business.name FROM businesses AS business WHERE business.id = order_record.business_id) AS business_name,
         $3::text AS publication_link, now() AS published_at,
         marked.publication_dates[$2 + 1] AS publication_date, $2 + 1 AS publication_number,
         cardinality(marked.publication_dates) AS publication_count,
         (SELECT COUNT(*)::integer FROM unnest(marked.next_statuses) AS status(value) WHERE status.value <> 'published') AS remaining_publications,
         NOT ('pending' = ANY(marked.next_statuses)) AS all_published,
         CASE WHEN 'pending' = ANY(marked.next_statuses) THEN NULL::timestamptz
           ELSE order_record.feedback_due_at END AS feedback_due_at,
         marked.feedback_delay_days_snapshot`,
      [orderId, publicationIndex, publicationLink],
    );
    const row = result.rows[0];
    return row ? {
      telegramId: row.telegram_id,
      orderNumber: row.order_number,
      businessName: row.business_name,
      publicationLink: row.publication_link,
      publishedAt: row.published_at.toISOString(),
      publicationDate: row.publication_date,
      publicationNumber: row.publication_number,
      publicationCount: row.publication_count,
      remainingPublications: row.remaining_publications,
      allPublished: row.all_published,
      feedbackDueAt: row.feedback_due_at?.toISOString() ?? null,
      feedbackDelayDays: row.feedback_delay_days_snapshot,
    } : undefined;
  }

  async scheduleOrder(orderId: string, scheduledAt: string): Promise<{ telegramId: string; orderNumber: string; publicationAt: string } | undefined> {
    const result = await this.database.query<{ telegram_id: string; order_number: string; publication_at: Date }>(
      `UPDATE orders SET publication_at = $2::timestamptz, updated_at = now() WHERE id = $1
         AND status = 'confirmed'
       RETURNING (SELECT telegram_id::text FROM users WHERE id = orders.user_id) AS telegram_id,
         order_number::text, publication_at`,
      [orderId, scheduledAt],
    );
    const row = result.rows[0];
    return row
      ? { telegramId: row.telegram_id, orderNumber: row.order_number, publicationAt: row.publication_at.toISOString() }
      : undefined;
  }

  async getOrderDateInfo(orderId: string): Promise<{
    id: string;
    orderNumber: string;
    status: string;
    publicationDates: string[];
    publicationDateStatuses: string[];
    publicationStatuses: string[];
  } | undefined> {
    const result = await this.database.query<{
      id: string;
      order_number: string;
      status: string;
      publication_dates: string[];
      publication_date_statuses: string[];
      publication_statuses: string[];
    }>(
      `SELECT id, order_number::text, status, publication_dates, publication_date_statuses, publication_statuses
       FROM orders WHERE id = $1`,
      [orderId],
    );
    const row = result.rows[0];
    return row ? {
      id: row.id,
      orderNumber: row.order_number,
      status: row.status,
      publicationDates: row.publication_dates,
      publicationDateStatuses: row.publication_date_statuses,
      publicationStatuses: row.publication_statuses,
    } : undefined;
  }

  async updateOrderPublicationDate(orderId: string, index: number, date: string): Promise<{
    telegramId: string;
    orderNumber: string;
    publicationDates: string[];
    publicationDateStatuses: string[];
  } | undefined> {
    const result = await this.database.query<{
      telegram_id: string;
      order_number: string;
      publication_dates: string[];
      publication_date_statuses: string[];
    }>(
      `UPDATE orders AS order_record
       SET publication_dates = ARRAY(
             SELECT CASE WHEN existing_dates.position = $2::bigint THEN $3 ELSE existing_dates.value END
             FROM unnest(order_record.publication_dates) WITH ORDINALITY AS existing_dates(value, position)
             ORDER BY existing_dates.position
           ), publication_date_statuses = ARRAY(
             SELECT CASE WHEN existing_dates.position = $2::bigint THEN 'awaiting_user' ELSE COALESCE(order_record.publication_date_statuses[existing_dates.position], 'awaiting_admin') END
             FROM unnest(order_record.publication_dates) WITH ORDINALITY AS existing_dates(value, position)
             ORDER BY existing_dates.position
           ), updated_at = now()
       WHERE order_record.id = $1 AND order_record.status = 'confirmed'
         AND $2 >= 1 AND $2 <= cardinality(order_record.publication_dates)
         AND COALESCE(order_record.publication_statuses[$2], 'pending') <> 'published'
       RETURNING (SELECT telegram_id::text FROM users WHERE id = order_record.user_id) AS telegram_id,
         order_number::text, publication_dates, publication_date_statuses`,
      [orderId, index + 1, date],
    );
    const row = result.rows[0];
    return row ? {
      telegramId: row.telegram_id,
      orderNumber: row.order_number,
      publicationDates: row.publication_dates,
      publicationDateStatuses: row.publication_date_statuses,
    } : undefined;
  }

  async recordMessage(adminTelegramId: string, userTelegramId: string, message: string): Promise<void> {
    await this.database.query(
      `INSERT INTO admin_messages (admin_id, user_id, message)
       SELECT admin.id, app_user.id, $3
       FROM admins AS admin CROSS JOIN users AS app_user
       WHERE admin.telegram_id = $1 AND admin.is_active = true
         AND app_user.telegram_id = $2`,
      [adminTelegramId, userTelegramId, message],
    );
  }
}
