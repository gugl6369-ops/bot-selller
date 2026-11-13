import type { Pool } from 'pg';
import type { OrderMaterialMedia, OrderMaterialState, ReusableOrderMaterials } from '../../types/order-material.ts';
import { mediaKey } from '../../services/order-material-media.ts';

export class OrderMaterialRepository {
  private readonly database: Pool;

  constructor(database: Pool) {
    this.database = database;
  }

  async startAfterPayment(orderId: string): Promise<OrderMaterialState | undefined> {
    await this.database.query(
      `INSERT INTO order_material_submissions (order_id)
       SELECT order_record.id
       FROM orders AS order_record
       JOIN payments AS payment ON payment.order_id = order_record.id AND payment.status = 'approved'
       WHERE order_record.id = $1 AND order_record.status = 'confirmed'
       ON CONFLICT (order_id) DO NOTHING`,
      [orderId],
    );
    return this.getForOrder(orderId);
  }

  async getReusableForOrder(orderId: string): Promise<ReusableOrderMaterials | undefined> {
    const result = await this.database.query<{
      source_order_id: string;
      source_order_number: string;
      source_business_name: string;
      ad_text: string;
      media: OrderMaterialMedia[];
      destination: string | null;
      wishes: string | null;
    }>(
      `SELECT source_order.id AS source_order_id, source_order.order_number::text AS source_order_number,
         source_business.name AS source_business_name, source_material.ad_text, source_material.media,
         source_material.destination, source_material.wishes
       FROM order_material_submissions AS current_material
       JOIN orders AS current_order ON current_order.id = current_material.order_id
       JOIN users AS app_user ON app_user.id = current_order.user_id
       JOIN order_material_submissions AS source_material ON source_material.order_id <> current_order.id
       JOIN orders AS source_order ON source_order.id = source_material.order_id
       JOIN businesses AS source_business ON source_business.id = source_order.business_id
       WHERE current_order.id = $1 AND current_order.status = 'confirmed'
         AND current_material.status = 'collecting' AND current_material.step = 0
         AND current_material.ad_text IS NULL AND current_material.media = '[]'::jsonb
         AND app_user.feedback_requests = true
         AND EXISTS (SELECT 1 FROM payments WHERE payments.order_id = current_order.id AND payments.status = 'approved')
         AND source_order.user_id = current_order.user_id
         AND source_order.status = 'completed' AND source_order.published_at IS NOT NULL
         AND source_order.feedback_response IN ('good', 'repeat')
         AND cardinality(source_order.publication_statuses) > 0
         AND NOT ('pending' = ANY(source_order.publication_statuses))
         AND source_material.status = 'approved' AND source_material.ad_text IS NOT NULL
       ORDER BY source_order.published_at DESC
       LIMIT 1`,
      [orderId],
    );
    const row = result.rows[0];
    return row ? {
      sourceOrderId: row.source_order_id,
      sourceOrderNumber: row.source_order_number,
      sourceBusinessName: row.source_business_name,
      adText: row.ad_text,
      media: row.media,
      destination: row.destination,
      wishes: row.wishes,
    } : undefined;
  }

  async reusePublishedMaterials(telegramId: string, orderId: string, sourceOrderNumber: string): Promise<boolean> {
    const result = await this.database.query(
      `UPDATE order_material_submissions AS current_material
       SET ad_text = source_material.ad_text,
         media = source_material.media,
         destination = source_material.destination,
         wishes = source_material.wishes,
         status = 'approved', step = 5, revision_mode = false, review_mode = false,
         is_paused = false, submitted_at = now(), reused_from_order_id = source_order.id,
         updated_at = now()
       FROM orders AS current_order
       JOIN users AS app_user ON app_user.id = current_order.user_id
       JOIN orders AS source_order ON source_order.order_number = $3::bigint
       JOIN order_material_submissions AS source_material ON source_material.order_id = source_order.id
       WHERE current_material.order_id = $2 AND current_order.id = current_material.order_id
         AND app_user.telegram_id = $1 AND app_user.feedback_requests = true
         AND current_order.status = 'confirmed'
         AND current_material.status = 'collecting' AND current_material.step = 0
         AND current_material.ad_text IS NULL AND current_material.media = '[]'::jsonb
         AND EXISTS (SELECT 1 FROM payments WHERE payments.order_id = current_order.id AND payments.status = 'approved')
         AND source_order.user_id = current_order.user_id
         AND source_order.status = 'completed' AND source_order.published_at IS NOT NULL
         AND source_order.feedback_response IN ('good', 'repeat')
         AND cardinality(source_order.publication_statuses) > 0
         AND NOT ('pending' = ANY(source_order.publication_statuses))
         AND source_material.status = 'approved' AND source_material.ad_text IS NOT NULL`,
      [telegramId, orderId, sourceOrderNumber],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async getActive(telegramId: string): Promise<OrderMaterialState | undefined> {
    const result = await this.database.query<{ order_id: string }>(
      `SELECT material.order_id
       FROM order_material_submissions AS material
       JOIN orders AS order_record ON order_record.id = material.order_id
       JOIN users AS app_user ON app_user.id = order_record.user_id
       WHERE app_user.telegram_id = $1 AND material.status = 'collecting' AND material.is_paused = false
       ORDER BY material.updated_at DESC LIMIT 1`,
      [telegramId],
    );
    const orderId = result.rows[0]?.order_id;
    return orderId ? this.getForOrder(orderId) : undefined;
  }

  async pauseActive(telegramId: string): Promise<OrderMaterialState | undefined> {
    const result = await this.database.query<{ order_id: string }>(
      `WITH active_material AS (
         SELECT material.order_id
         FROM order_material_submissions AS material
         JOIN orders AS order_record ON order_record.id = material.order_id
         JOIN users AS app_user ON app_user.id = order_record.user_id
         WHERE app_user.telegram_id = $1 AND material.status = 'collecting' AND material.is_paused = false
         ORDER BY material.updated_at DESC
         LIMIT 1
         FOR UPDATE OF material
       )
       UPDATE order_material_submissions AS material
       SET is_paused = true, updated_at = now()
       FROM active_material
       WHERE material.order_id = active_material.order_id
       RETURNING material.order_id`,
      [telegramId],
    );
    const orderId = result.rows[0]?.order_id;
    return orderId ? this.getForOrder(orderId) : undefined;
  }

  async resumePaused(telegramId: string): Promise<OrderMaterialState | undefined> {
    const result = await this.database.query<{ order_id: string }>(
      `WITH paused_material AS (
         SELECT material.order_id
         FROM order_material_submissions AS material
         JOIN orders AS order_record ON order_record.id = material.order_id
         JOIN users AS app_user ON app_user.id = order_record.user_id
         WHERE app_user.telegram_id = $1 AND material.status = 'collecting' AND material.is_paused = true
         ORDER BY material.updated_at DESC
         LIMIT 1
         FOR UPDATE OF material
       )
       UPDATE order_material_submissions AS material
       SET is_paused = false, updated_at = now()
       FROM paused_material
       WHERE material.order_id = paused_material.order_id
       RETURNING material.order_id`,
      [telegramId],
    );
    const orderId = result.rows[0]?.order_id;
    return orderId ? this.getForOrder(orderId) : undefined;
  }

  async getForOrder(orderId: string): Promise<OrderMaterialState | undefined> {
    const result = await this.database.query<{
      order_id: string;
      order_number: string;
      telegram_id: string;
      status: 'collecting' | 'submitted' | 'approved' | 'rejected';
      step: number;
      revision_mode: boolean;
      review_mode: boolean;
      ad_text: string | null;
      media: OrderMaterialMedia[];
      destination: string | null;
      publication_dates: string[];
      wishes: string | null;
      admin_comment: string | null;
      admin_telegram_ids: string[];
    }>(
      `SELECT material.order_id, order_record.order_number::text, app_user.telegram_id::text,
         material.status, material.step, material.revision_mode, material.review_mode, material.ad_text, material.media,
         material.destination, order_record.publication_dates,
         material.wishes, material.admin_comment,
         COALESCE((SELECT array_agg(telegram_id::text ORDER BY telegram_id)
                   FROM admins WHERE is_active = true), ARRAY[]::text[]) AS admin_telegram_ids
       FROM order_material_submissions AS material
       JOIN orders AS order_record ON order_record.id = material.order_id
       JOIN users AS app_user ON app_user.id = order_record.user_id
       WHERE material.order_id = $1`,
      [orderId],
    );
    const row = result.rows[0];
    if (!row) return undefined;
    return {
      orderId: row.order_id,
      orderNumber: row.order_number,
      telegramId: row.telegram_id,
      status: row.status,
      step: row.step,
      revisionMode: row.revision_mode,
      reviewMode: row.review_mode,
      adText: row.ad_text,
      media: row.media,
      destination: row.destination,
      requestedDates: row.publication_dates,
      wishes: row.wishes,
      adminComment: row.admin_comment,
      adminTelegramIds: row.admin_telegram_ids,
    };
  }

  async saveAdText(orderId: string, value: string): Promise<boolean> {
    const result = await this.database.query(
      `UPDATE order_material_submissions
       SET ad_text = $2,
           step = CASE WHEN revision_mode THEN 6 WHEN review_mode THEN 4 ELSE 1 END,
           review_mode = false,
           updated_at = now()
       WHERE order_id = $1 AND status = 'collecting' AND is_paused = false AND step = 0`,
      [orderId, value],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async saveAdTextWithMedia(orderId: string, value: string, media: OrderMaterialMedia): Promise<boolean> {
    const result = await this.database.query(
      `UPDATE order_material_submissions
       SET ad_text = $2, media = media || $3::jsonb, step = 1, updated_at = now()
       WHERE order_id = $1 AND status = 'collecting' AND step = 0
         AND is_paused = false
         AND revision_mode = false
         AND jsonb_array_length(media) < 10`,
      [orderId, value, JSON.stringify([media])],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async addMedia(orderId: string, media: OrderMaterialMedia): Promise<boolean> {
    const result = await this.database.query(
      `UPDATE order_material_submissions
       SET media = media || $2::jsonb, updated_at = now()
       WHERE order_id = $1 AND status = 'collecting' AND is_paused = false AND step BETWEEN 0 AND 4
         AND (revision_mode = false OR step = 1)
         AND jsonb_array_length(media) < 10`,
      [orderId, JSON.stringify([media])],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async advanceFromMedia(orderId: string): Promise<boolean> {
    const result = await this.database.query(
      `UPDATE order_material_submissions
       SET step = CASE WHEN revision_mode THEN 6 WHEN review_mode THEN 4 ELSE 2 END,
           review_mode = false, updated_at = now()
       WHERE order_id = $1 AND status = 'collecting' AND is_paused = false AND step = 1`,
      [orderId],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async saveDestination(orderId: string, value: string): Promise<boolean> {
    const result = await this.database.query(
      `UPDATE order_material_submissions
       SET destination = $2, step = CASE WHEN revision_mode THEN 6 WHEN review_mode THEN 4 ELSE 3 END,
           review_mode = false, updated_at = now()
       WHERE order_id = $1 AND status = 'collecting' AND is_paused = false AND step = 2`,
      [orderId, value],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async saveWishesDraft(orderId: string, value: string): Promise<OrderMaterialState | undefined> {
    await this.database.query(
      `UPDATE order_material_submissions SET wishes = $2, step = 4, review_mode = false, updated_at = now()
       WHERE order_id = $1 AND status = 'collecting' AND is_paused = false AND step = 3 AND revision_mode = false`,
      [orderId, value],
    );
    return this.getForOrder(orderId);
  }

  async selectReviewField(orderId: string, step: 0 | 1 | 2 | 3): Promise<boolean> {
    const result = await this.database.query(
      `UPDATE order_material_submissions SET step = $2, review_mode = true, updated_at = now()
       WHERE order_id = $1 AND status = 'collecting' AND is_paused = false
         AND revision_mode = false AND step = 4`,
      [orderId, step],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async submitMaterials(orderId: string): Promise<OrderMaterialState | undefined> {
    await this.database.query(
      `UPDATE order_material_submissions SET status = 'submitted', step = 5, review_mode = false,
         submitted_at = now(), updated_at = now()
       WHERE order_id = $1 AND status = 'collecting' AND is_paused = false
         AND revision_mode = false AND step = 4`,
      [orderId],
    );
    return this.getForOrder(orderId);
  }

  async saveWishes(orderId: string, value: string): Promise<boolean> {
    const result = await this.database.query(
      `UPDATE order_material_submissions
       SET wishes = $2, step = 6, updated_at = now()
       WHERE order_id = $1 AND status = 'collecting' AND is_paused = false AND step = 4 AND revision_mode = true`,
      [orderId, value],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async selectRevisionField(orderId: string, step: 0 | 1 | 2 | 3 | 4): Promise<boolean> {
    const result = await this.database.query(
      `UPDATE order_material_submissions SET step = $2, updated_at = now()
       WHERE order_id = $1 AND status = 'collecting' AND is_paused = false AND revision_mode = true AND step = 6`,
      [orderId, step],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async returnToRevisionMenu(orderId: string): Promise<boolean> {
    const result = await this.database.query(
      `UPDATE order_material_submissions SET step = 6, updated_at = now()
       WHERE order_id = $1 AND status = 'collecting' AND is_paused = false AND revision_mode = true AND step BETWEEN 0 AND 4`,
      [orderId],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async removeMedia(orderId: string, index: number, expectedKey: string): Promise<boolean> {
    const client = await this.database.connect();
    try {
      await client.query('BEGIN');
      const selected = await client.query<{ media: OrderMaterialMedia[] }>(
        `SELECT media FROM order_material_submissions
         WHERE order_id = $1 AND status = 'collecting' AND is_paused = false
           AND (step BETWEEN 0 AND 4 OR (revision_mode = true AND step = 6))
         FOR UPDATE`,
        [orderId],
      );
      const media = selected.rows[0]?.media ?? [];
      const target = media[index];
      if (!target || mediaKey(target.fileId) !== expectedKey) {
        await client.query('ROLLBACK');
        return false;
      }
      media.splice(index, 1);
      await client.query(
        `UPDATE order_material_submissions SET media = $2::jsonb, updated_at = now() WHERE order_id = $1`,
        [orderId, JSON.stringify(media)],
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

  async submitRevision(orderId: string): Promise<OrderMaterialState | undefined> {
    await this.database.query(
      `UPDATE order_material_submissions SET status = 'submitted', step = 5, revision_mode = false,
         admin_comment = NULL, submitted_at = now(), updated_at = now()
       WHERE order_id = $1 AND status = 'collecting' AND is_paused = false AND revision_mode = true AND step = 6`,
      [orderId],
    );
    return this.getForOrder(orderId);
  }

  async removeRevisionMode(orderId: string): Promise<boolean> {
    const result = await this.database.query(
      `UPDATE order_material_submissions SET revision_mode = false, admin_comment = NULL, updated_at = now()
       WHERE order_id = $1 AND status = 'collecting' AND is_paused = false AND revision_mode = true`,
      [orderId],
    );
    return (result.rowCount ?? 0) > 0;
  }
}
