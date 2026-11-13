import type { Pool } from 'pg';
import type { AdminTariff, AdminBusinessLead, AdminInquiry } from '../../../types/admin.ts';
import { DATA_DELETION_INQUIRY_TOPIC } from '../../../services/inquiry-topics.ts';
export class AdminCatalogRepository {
  private readonly database: Pool;

  constructor(database: Pool) {
    this.database = database;
  }

  async getPaymentMethodRequest(id: string) {
    const result = await this.database.query<{
      request_id: string; order_id: string; order_number: string; telegram_id: string;
      first_name: string; username: string | null; business_name: string; price: string; currency: string;
    }>(
      `SELECT request.id AS request_id, order_record.id AS order_id, order_record.order_number::text,
         app_user.telegram_id::text, app_user.first_name, app_user.username, business.name AS business_name,
         order_record.price::text, order_record.currency
       FROM payment_method_requests AS request
       JOIN orders AS order_record ON order_record.id = request.order_id
       JOIN users AS app_user ON app_user.id = request.user_id
       JOIN businesses AS business ON business.id = order_record.business_id
       WHERE request.id = $1 AND request.status = 'pending' AND request.message IS NOT NULL AND order_record.status = 'confirmed'`,
      [id],
    );
    const row = result.rows[0];
    return row ? {
      requestId: row.request_id, orderId: row.order_id, orderNumber: row.order_number,
      telegramId: row.telegram_id, firstName: row.first_name, username: row.username,
      businessName: row.business_name, amount: row.price, currency: row.currency,
    } : undefined;
  }

  async markPaymentMethodRequestAnswered(id: string): Promise<void> {
    await this.database.query(
      `UPDATE payment_method_requests SET status = 'answered', answered_at = now() WHERE id = $1 AND status = 'pending'`,
      [id],
    );
  }

  async listTariffs(): Promise<AdminTariff[]> {
    const result = await this.database.query<{
      id: string;
      name: string;
      platforms: string;
      inclusions: string;
      publication_count: number | null;
      placement_duration: string;
      feedback_delay_days: number;
      description: string;
      price: string;
      currency: string;
      discount_valid_until: string | null;
      is_active: boolean;
    }>(
      `SELECT id, name, platforms, inclusions, publication_count, placement_duration, feedback_delay_days,
         description, price::text, currency, discount_valid_until::text, is_active
       FROM tariffs WHERE is_archived = false ORDER BY is_active DESC, name ASC`,
    );
    return result.rows.map((row) => ({
      id: row.id,
      name: row.name,
      platforms: row.platforms,
      inclusions: row.inclusions,
      publicationCount: row.publication_count,
      placementDuration: row.placement_duration,
      feedbackDelayDays: row.feedback_delay_days,
      description: row.description,
      price: row.price,
      currency: row.currency,
      discountValidUntil: row.discount_valid_until,
      isActive: row.is_active,
    }));
  }

  async createTariff(
    name: string,
    platforms: string,
    inclusions: string,
    publicationCount: number | null,
    placementDuration: string,
    feedbackDelayDays: number,
    description: string,
    price: string,
    discountValidUntil: string | null,
  ): Promise<void> {
    await this.database.query(
      `INSERT INTO tariffs (name, platforms, inclusions, publication_count, placement_duration, feedback_delay_days,
         description, price, discount_valid_until)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::numeric, $9::date)`,
      [name, platforms, inclusions, publicationCount, placementDuration, feedbackDelayDays, description, price, discountValidUntil],
    );
  }

  async updateTariff(
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
  ): Promise<void> {
    await this.database.query(
      `UPDATE tariffs SET name = $2, platforms = $3, inclusions = $4, publication_count = $5,
         placement_duration = $6, feedback_delay_days = $7, description = $8, price = $9::numeric,
         discount_valid_until = $10::date, updated_at = now()
       WHERE id = $1`,
      [id, name, platforms, inclusions, publicationCount, placementDuration, feedbackDelayDays, description, price, discountValidUntil],
    );
  }

  async setTariffActive(id: string, isActive: boolean): Promise<void> {
    await this.database.query(
      `UPDATE tariffs SET is_active = $2, updated_at = now() WHERE id = $1 AND is_archived = false`,
      [id, isActive],
    );
  }

  async deleteTariff(id: string): Promise<'deleted' | 'referenced' | 'missing'> {
    try {
      const result = await this.database.query(`DELETE FROM tariffs WHERE id = $1`, [id]);
      return result.rowCount ? 'deleted' : 'missing';
    } catch (error) {
      if (typeof error === 'object' && error !== null && 'code' in error && error.code === '23503') return 'referenced';
      throw error;
    }
  }

  async listBusinessLeads(days: number | null = null, search: string | null = null): Promise<AdminBusinessLead[]> {
    const result = await this.database.query<{
      id: string;
      telegram_id: string;
      username: string | null;
      first_name: string;
      business_name: string;
      industry: string | null;
      region: string | null;
      website_url: string | null;
      contact_value: string | null;
      requested_placement: string | null;
      created_at: Date;
    }>(
      `SELECT business.id, app_user.telegram_id::text, app_user.username, app_user.first_name,
         business.name AS business_name, business.industry, business.region,
         business.website_url, business.contact_value, business.requested_placement,
         business.created_at
       FROM businesses AS business
       JOIN users AS app_user ON app_user.id = business.user_id
       WHERE ($1::integer IS NULL OR business.created_at >= now() - ($1::integer * interval '1 day'))
         AND ($2::text IS NULL
           OR app_user.first_name ILIKE '%' || $2 || '%'
           OR COALESCE(app_user.username, '') ILIKE '%' || LTRIM($2, '@') || '%'
           OR business.name ILIKE '%' || $2 || '%')
       ORDER BY business.created_at DESC`,
      [days, search],
    );
    return result.rows.map((row) => ({
      id: row.id,
      telegramId: row.telegram_id,
      username: row.username,
      firstName: row.first_name,
      businessName: row.business_name,
      industry: row.industry,
      region: row.region,
      websiteUrl: row.website_url,
      contactValue: row.contact_value,
      requestedPlacement: row.requested_placement,
      createdAt: row.created_at.toISOString(),
    }));
  }

  async countBusinessLeads(): Promise<number> {
    const result = await this.database.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM businesses`,
    );
    return Number(result.rows[0]?.count ?? 0);
  }

  async listNewUserBusinessLeads(): Promise<AdminBusinessLead[]> {
    const result = await this.database.query<{
      id: string;
      telegram_id: string;
      username: string | null;
      first_name: string;
      business_name: string;
      industry: string | null;
      region: string | null;
      website_url: string | null;
      contact_value: string | null;
      requested_placement: string | null;
      created_at: Date;
    }>(
      `SELECT business.id, app_user.telegram_id::text, app_user.username, app_user.first_name,
         business.name AS business_name, business.industry, business.region,
         business.website_url, business.contact_value, business.requested_placement,
         business.created_at
       FROM businesses AS business
       JOIN users AS app_user ON app_user.id = business.user_id
       WHERE app_user.created_at >= now() - interval '1 day'
       ORDER BY business.created_at DESC
       LIMIT 20`,
    );
    return result.rows.map((row) => ({
      id: row.id,
      telegramId: row.telegram_id,
      username: row.username,
      firstName: row.first_name,
      businessName: row.business_name,
      industry: row.industry,
      region: row.region,
      websiteUrl: row.website_url,
      contactValue: row.contact_value,
      requestedPlacement: row.requested_placement,
      createdAt: row.created_at.toISOString(),
    }));
  }

  async countNewUserBusinessLeads(): Promise<number> {
    const result = await this.database.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
       FROM businesses AS business
       JOIN users AS app_user ON app_user.id = business.user_id
       WHERE app_user.created_at >= now() - interval '1 day'`,
    );
    return Number(result.rows[0]?.count ?? 0);
  }

  async listInquiries(topic: string | null = null): Promise<AdminInquiry[]> {
    const result = await this.database.query<{
      id: string;
      telegram_id: string;
      first_name: string;
      username: string | null;
      topic: string;
      business_name: string | null;
      message: string;
      source: string;
      created_at: Date;
    }>(
      `SELECT inquiry.id, app_user.telegram_id::text, app_user.first_name, app_user.username,
         inquiry.topic, inquiry.message, inquiry.source, inquiry.created_at,
         (SELECT business.name FROM businesses AS business WHERE business.user_id = app_user.id ORDER BY business.created_at ASC LIMIT 1) AS business_name
       FROM inquiries AS inquiry
       JOIN users AS app_user ON app_user.id = inquiry.user_id
       WHERE ($1::text IS NULL OR inquiry.topic = $1)
       ORDER BY inquiry.created_at DESC LIMIT 20`,
      [topic],
    );
    return result.rows.map((row) => ({
      id: row.id,
      telegramId: row.telegram_id,
      firstName: row.first_name,
      username: row.username,
      businessName: row.business_name,
      topic: row.topic,
      message: row.message,
      source: row.source,
      createdAt: row.created_at.toISOString(),
    }));
  }

  async listDataDeletionRequests(): Promise<AdminInquiry[]> {
    return this.listInquiries(DATA_DELETION_INQUIRY_TOPIC);
  }

  async getInquiry(inquiryId: string): Promise<AdminInquiry | undefined> {
    const result = await this.database.query<{
      id: string;
      telegram_id: string;
      first_name: string;
      username: string | null;
      topic: string;
      business_name: string | null;
      message: string;
      source: string;
      created_at: Date;
    }>(
      `SELECT inquiry.id, app_user.telegram_id::text, app_user.first_name, app_user.username,
         inquiry.topic, inquiry.message, inquiry.source, inquiry.created_at,
         (SELECT business.name FROM businesses AS business WHERE business.user_id = app_user.id ORDER BY business.created_at ASC LIMIT 1) AS business_name
       FROM inquiries AS inquiry
       JOIN users AS app_user ON app_user.id = inquiry.user_id
       WHERE inquiry.id = $1`,
      [inquiryId],
    );
    const row = result.rows[0];
    return row ? {
      id: row.id,
      telegramId: row.telegram_id,
      firstName: row.first_name,
      username: row.username,
      businessName: row.business_name,
      topic: row.topic,
      message: row.message,
      source: row.source,
      createdAt: row.created_at.toISOString(),
    } : undefined;
  }

  async deleteInquiry(inquiryId: string): Promise<boolean> {
    const result = await this.database.query('DELETE FROM inquiries WHERE id = $1', [inquiryId]);
    return (result.rowCount ?? 0) > 0;
  }

  async deleteUserDataForInquiry(inquiryId: string): Promise<boolean> {
    const client = await this.database.connect();
    try {
      await client.query('BEGIN');
      const request = await client.query<{ user_id: string; telegram_id: string }>(
        `SELECT inquiry.user_id, app_user.telegram_id::text
         FROM inquiries AS inquiry
         JOIN users AS app_user ON app_user.id = inquiry.user_id
         WHERE inquiry.id = $1 AND inquiry.topic = $2
         FOR UPDATE OF inquiry, app_user`,
        [inquiryId, DATA_DELETION_INQUIRY_TOPIC],
      );
      const user = request.rows[0];
      if (!user) {
        await client.query('ROLLBACK');
        return false;
      }

      await client.query(
        `DELETE FROM referral_clicks
         WHERE referrer_user_id = $1 OR visitor_telegram_id = $2`,
        [user.user_id, user.telegram_id],
      );
      await client.query(
        'DELETE FROM referral_bonuses WHERE referrer_user_id = $1 OR invited_user_id = $1',
        [user.user_id],
      );
      await client.query('DELETE FROM admin_messages WHERE user_id = $1', [user.user_id]);
      await client.query(
        `DELETE FROM order_material_submissions
         WHERE order_id IN (SELECT id FROM orders WHERE user_id = $1)`,
        [user.user_id],
      );
      await client.query(
        `DELETE FROM payment_proof_requests
         WHERE order_id IN (SELECT id FROM orders WHERE user_id = $1)`,
        [user.user_id],
      );
      await client.query(`DELETE FROM payment_method_requests WHERE user_id = $1`, [user.user_id]);
      await client.query(
        `DELETE FROM payments
         WHERE order_id IN (SELECT id FROM orders WHERE user_id = $1)`,
        [user.user_id],
      );
      await client.query('DELETE FROM orders WHERE user_id = $1', [user.user_id]);
      await client.query('DELETE FROM order_drafts WHERE user_id = $1', [user.user_id]);
      await client.query('DELETE FROM businesses WHERE user_id = $1', [user.user_id]);
      await client.query('DELETE FROM inquiries WHERE user_id = $1', [user.user_id]);
      const deleted = await client.query('DELETE FROM users WHERE id = $1', [user.user_id]);
      await client.query('COMMIT');
      return (deleted.rowCount ?? 0) > 0;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}
