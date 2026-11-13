import type { Pool } from 'pg';
import type {
  ActiveTariff,
  AdvertiserAnswers,
  AdvertiserFlowState as FlowState,
  AdvertiserFlowType as FlowType,
  ReferralStats,
  SavedInquiry,
} from '../../types/advertiser.ts';

export class AdvertiserRepository {
  private readonly database: Pool;

  constructor(database: Pool) {
    this.database = database;
  }

  async hasBusiness(telegramId: string): Promise<boolean> {
    const result = await this.database.query<{ has_business: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM businesses
         WHERE user_id = (SELECT id FROM users WHERE telegram_id = $1)
       ) AS has_business`,
      [telegramId],
    );

    return result.rows[0]?.has_business ?? false;
  }

  async getFlow(telegramId: string): Promise<FlowState | undefined> {
    const result = await this.database.query<{
      flow_type: FlowType;
      step: number;
      payload: Record<string, string>;
    }>(
      `SELECT flow.flow_type, flow.step, flow.payload
       FROM user_flows AS flow
       JOIN users AS app_user ON app_user.id = flow.user_id
       WHERE app_user.telegram_id = $1`,
      [telegramId],
    );
    const row = result.rows[0];

    return row
      ? { flowType: row.flow_type, step: row.step, payload: row.payload }
      : undefined;
  }

  async saveFlow(telegramId: string, state: FlowState): Promise<void> {
    await this.database.query(
      `INSERT INTO user_flows (user_id, flow_type, step, payload)
       SELECT id, $2, $3, $4::jsonb FROM users WHERE telegram_id = $1
       ON CONFLICT (user_id) DO UPDATE
       SET flow_type = EXCLUDED.flow_type,
           step = EXCLUDED.step,
           payload = EXCLUDED.payload,
           updated_at = now()`,
      [telegramId, state.flowType, state.step, JSON.stringify(state.payload)],
    );
  }

  async clearFlow(telegramId: string): Promise<void> {
    await this.database.query(
      `DELETE FROM user_flows
       WHERE user_id = (SELECT id FROM users WHERE telegram_id = $1)`,
      [telegramId],
    );
  }

  async updateContactValue(telegramId: string, contactValue: string): Promise<boolean> {
    const result = await this.database.query(
      `UPDATE businesses SET contact_value = $2, updated_at = now()
       WHERE user_id = (SELECT id FROM users WHERE telegram_id = $1)`,
      [telegramId, contactValue],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async saveBusiness(telegramId: string, answers: AdvertiserAnswers): Promise<boolean> {
    const client = await this.database.connect();
    try {
      await client.query('BEGIN');
      const user = await client.query<{ id: string; first_name: string }>(
        `SELECT id, first_name FROM users WHERE telegram_id = $1 FOR UPDATE`,
        [telegramId],
      );
      const profile = user.rows[0];
      if (!profile) throw new Error(`Could not find Telegram user ${telegramId}.`);

      const existing = await client.query<{ id: string }>(
        `SELECT id FROM businesses WHERE user_id = $1 LIMIT 1`,
        [profile.id],
      );
      if (existing.rows[0]) {
        await client.query('COMMIT');
        return false;
      }

      await client.query(
        `INSERT INTO businesses (
           user_id, name, industry, region, website_url, contact_name, contact_value, requested_placement
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          profile.id,
          answers.businessName,
          answers.industry,
          answers.region,
          answers.websiteUrl,
          profile.first_name,
          answers.contactValue,
          answers.requestedPlacement,
        ],
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

  async getActiveTariffs(telegramId: string): Promise<ActiveTariff[]> {
    const result = await this.database.query<ActiveTariff>(
      `WITH selected_user AS (
         SELECT id FROM users WHERE telegram_id = $1
       )
       SELECT tariff.id, tariff.name, tariff.platforms, tariff.inclusions,
         tariff.publication_count AS "publicationCount", tariff.placement_duration AS "placementDuration",
         tariff.description, tariff.price::text, tariff.currency,
         CASE WHEN NOT EXISTS (
           SELECT 1 FROM orders AS order_record
           WHERE order_record.user_id = selected_user.id
             AND order_record.status NOT IN ('rejected', 'cancelled')
         ) AND tariff.discount_valid_until >= CURRENT_DATE
         THEN (tariff.price * 0.9)::numeric(12, 2)::text ELSE NULL END AS "discountedPrice"
       FROM tariffs AS tariff
       CROSS JOIN selected_user
       WHERE tariff.is_active = true
       ORDER BY tariff.price ASC, tariff.name ASC`,
      [telegramId],
    );

    return result.rows;
  }

  async getReferralStats(telegramId: string): Promise<ReferralStats> {
    const result = await this.database.query<{
      referral_code: string;
      clicks: string;
      referrals: string;
      applications: string;
      paid_referrals: string;
      earned_bonuses: string;
      used_bonuses: string;
      bonus_offer: string;
    }>(
      `SELECT
         app_user.referral_code,
         COUNT(DISTINCT click.visitor_telegram_id)::text AS clicks,
         COUNT(DISTINCT invited.id)::text AS referrals,
         COUNT(DISTINCT business.id)::text AS applications,
         COUNT(DISTINCT CASE WHEN payment.status = 'approved' THEN invited.id END)::text AS paid_referrals,
         COALESCE((SELECT string_agg(balance.total || ' ' || balance.currency, ', ' ORDER BY balance.currency)
           FROM (SELECT currency, SUM(GREATEST(amount - used_amount, 0))::numeric(12,2)::text AS total
             FROM referral_bonuses WHERE referrer_user_id = app_user.id AND status = 'accrued'
               AND (expires_at IS NULL OR expires_at > now()) GROUP BY currency) AS balance), '0') AS earned_bonuses,
         COALESCE((SELECT string_agg(balance.total || ' ' || balance.currency, ', ' ORDER BY balance.currency)
           FROM (SELECT currency, SUM(used_amount)::numeric(12,2)::text AS total
             FROM referral_bonuses WHERE referrer_user_id = app_user.id AND status <> 'cancelled'
               AND used_amount > 0 GROUP BY currency) AS balance), '0') AS used_bonuses,
         (SELECT CASE WHEN settings.is_active
           THEN settings.bonus_amount::text || ' ' || BTRIM(settings.currency)
             || CASE WHEN settings.validity_days IS NULL THEN ' без срока' ELSE ' на ' || settings.validity_days::text || ' дн.' END
             || CASE WHEN settings.combine_with_first_discount THEN '; совмещается со скидкой на первое размещение' ELSE '; не совмещается со скидкой на первое размещение' END
             || '; тарифы: ' || CASE WHEN settings.eligible_tariff_ids IS NULL THEN 'все активные' ELSE COALESCE((
               SELECT string_agg(tariff.name, ', ' ORDER BY tariff.name)
               FROM tariffs AS tariff WHERE tariff.id = ANY(settings.eligible_tariff_ids) AND tariff.is_active = true
             ), 'подходящих активных тарифов сейчас нет') END
           ELSE 'начисление пока отключено' END
          FROM referral_program_settings AS settings WHERE settings.singleton = true) AS bonus_offer
       FROM users AS app_user
       LEFT JOIN referral_clicks AS click ON click.referrer_user_id = app_user.id
       LEFT JOIN users AS invited ON invited.referred_by_user_id = app_user.id
       LEFT JOIN businesses AS business ON business.user_id = invited.id
       LEFT JOIN orders AS order_record ON order_record.user_id = invited.id
       LEFT JOIN payments AS payment ON payment.order_id = order_record.id
       WHERE app_user.telegram_id = $1
       GROUP BY app_user.id, app_user.referral_code`,
      [telegramId],
    );
    const row = result.rows[0];

    if (!row) {
      throw new Error(`Could not find Telegram user ${telegramId} for referral stats.`);
    }

    return {
      referralCode: row.referral_code,
      clicks: Number(row.clicks),
      referrals: Number(row.referrals),
      applications: Number(row.applications),
      paidReferrals: Number(row.paid_referrals),
      earnedBonuses: row.earned_bonuses,
      usedBonuses: row.used_bonuses,
      bonusOffer: row.bonus_offer,
    };
  }

  async createInquiry(telegramId: string, topic: string, message: string): Promise<SavedInquiry> {
    const result = await this.database.query<{ id: string; source: string }>(
      `INSERT INTO inquiries (user_id, topic, message, source)
       SELECT id, $2, $3, COALESCE(NULLIF(start_parameter, ''), 'organic')
       FROM users WHERE telegram_id = $1
       RETURNING id, source`,
      [telegramId, topic, message],
    );
    const inquiry = result.rows[0];

    if (!inquiry) {
      throw new Error(`Could not save inquiry for Telegram user ${telegramId}.`);
    }

    const admins = await this.database.query<{ telegram_id: string }>(
      `SELECT telegram_id::text FROM admins WHERE is_active = true ORDER BY telegram_id`,
    );
    const latestOrder = await this.database.query<{ order_number: string }>(
      `SELECT order_number::text
       FROM orders
       WHERE user_id = (SELECT user_id FROM inquiries WHERE id = $1)
       ORDER BY created_at DESC
       LIMIT 1`,
      [inquiry.id],
    );

    return {
      id: inquiry.id,
      source: inquiry.source,
      orderNumber: latestOrder.rows[0]?.order_number,
      adminTelegramIds: admins.rows.map((admin) => admin.telegram_id),
    };
  }
}
