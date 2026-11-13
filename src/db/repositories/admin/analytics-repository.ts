import type { Pool } from 'pg';
import type { AdminStatistics, PopularTariff, ReferralBonusSettings, ReferralRow } from '../../../types/admin.ts';
export class AdminAnalyticsRepository {
  private readonly database: Pool;

  constructor(database: Pool) {
    this.database = database;
  }

  async getStatistics(): Promise<AdminStatistics> {
    const result = await this.database.query<AdminStatistics>(
      `SELECT
         (SELECT COUNT(*)::text FROM users) AS users,
         (SELECT COUNT(*)::text FROM businesses) AS businesses,
         (SELECT COUNT(*)::text FROM inquiries) AS inquiries,
         (SELECT COUNT(*)::text FROM referral_clicks) AS referral_clicks,
         (SELECT COUNT(*)::text FROM tariffs WHERE is_active = true) AS active_tariffs,
         (SELECT COUNT(*)::text FROM payments WHERE status = 'approved') AS confirmed_payments,
         (SELECT COUNT(*)::text FROM payments WHERE status = 'rejected') AS rejected_payments,
         (SELECT COUNT(*)::text FROM orders WHERE status = 'cancelled') AS cancelled_orders,
         (SELECT COUNT(*)::text FROM orders
          WHERE EXISTS (SELECT 1 FROM unnest(publication_dates) AS dates(value) WHERE dates.value <> '')) AS scheduled_publications,
         (SELECT COUNT(*)::text FROM orders JOIN tariffs ON tariffs.id = orders.tariff_id WHERE orders.price < tariffs.price) AS discounted_orders,
         (SELECT COUNT(*)::text FROM orders WHERE status = 'completed') AS published_orders,
         (SELECT COUNT(*)::text FROM (
           SELECT user_id FROM orders GROUP BY user_id HAVING COUNT(*) > 1
         ) AS returning_customers) AS repeat_customers,
         (SELECT COUNT(*)::text FROM order_feedback WHERE response = 'good') AS positive_feedback,
         (SELECT COUNT(*)::text FROM order_feedback WHERE response = 'discuss') AS discussion_feedback`,
    );
    return result.rows[0];
  }

  async getPopularTariffs(): Promise<PopularTariff[]> {
    const result = await this.database.query<PopularTariff>(
      `SELECT tariff_name_snapshot AS name, COUNT(*)::text AS orders
       FROM orders GROUP BY tariff_name_snapshot
       ORDER BY COUNT(*) DESC LIMIT 5`,
    );
    return result.rows;
  }

  async getReferralOverview(): Promise<ReferralRow[]> {
    const result = await this.database.query<ReferralRow>(
      `SELECT app_user.first_name AS "firstName", app_user.telegram_id::text AS "telegramId",
         app_user.username,
         (SELECT business.name FROM businesses AS business WHERE business.user_id = app_user.id ORDER BY business.created_at ASC LIMIT 1) AS "businessName",
         COUNT(DISTINCT click.visitor_telegram_id)::text AS clicks,
         COUNT(DISTINCT invited.id)::text AS invited,
         COUNT(DISTINCT business.id)::text AS applications,
         COUNT(DISTINCT CASE WHEN payment.status = 'approved' THEN invited.id END)::text AS paid
       FROM users AS app_user
       LEFT JOIN referral_clicks AS click ON click.referrer_user_id = app_user.id
       LEFT JOIN users AS invited ON invited.referred_by_user_id = app_user.id
       LEFT JOIN businesses AS business ON business.user_id = invited.id
       LEFT JOIN orders AS order_record ON order_record.user_id = invited.id
       LEFT JOIN payments AS payment ON payment.order_id = order_record.id
       WHERE app_user.referral_code IS NOT NULL
       GROUP BY app_user.id, app_user.first_name, app_user.telegram_id, app_user.username
       HAVING COUNT(DISTINCT click.visitor_telegram_id) > 0 OR COUNT(DISTINCT invited.id) > 0
       ORDER BY COUNT(DISTINCT click.visitor_telegram_id) DESC LIMIT 10`,
    );
    return result.rows;
  }

  async getReferralBonusSettings(): Promise<ReferralBonusSettings> {
    const result = await this.database.query<{
      bonus_amount: string;
      currency: string;
      validity_days: number | null;
      combine_with_first_discount: boolean;
      eligible_tariff_ids: string[] | null;
      is_active: boolean;
    }>(
      `SELECT bonus_amount::text, currency, validity_days, combine_with_first_discount,
         eligible_tariff_ids::text[], is_active
       FROM referral_program_settings WHERE singleton = true`,
    );
    const row = result.rows[0];
    if (!row) throw new Error('Referral bonus settings row is missing.');
    return {
      amount: row.bonus_amount,
      currency: row.currency.trim(),
      validityDays: row.validity_days,
      combineWithFirstDiscount: row.combine_with_first_discount,
      eligibleTariffIds: row.eligible_tariff_ids,
      isActive: row.is_active,
    };
  }

  async updateReferralBonusSettings(settings: ReferralBonusSettings): Promise<void> {
    await this.database.query(
      `UPDATE referral_program_settings SET bonus_amount = $1::numeric, currency = $2,
         validity_days = $3, combine_with_first_discount = $4, eligible_tariff_ids = $5::uuid[],
         is_active = ($1::numeric > 0), updated_at = now()
       WHERE singleton = true`,
      [settings.amount, settings.currency, settings.validityDays, settings.combineWithFirstDiscount, settings.eligibleTariffIds],
    );
  }
}
