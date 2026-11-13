import type { Pool } from 'pg';
import type { TelegramProfile, UserPreferenceKey, UserPreferences, UserRecord } from '../../types/user.ts';

export class UserRepository {
  private readonly database: Pool;

  constructor(database: Pool) {
    this.database = database;
  }

  async getOrCreate(profile: TelegramProfile): Promise<UserRecord> {
    const inserted = await this.database.query<{ id: string }>(
      `INSERT INTO users (telegram_id, username, first_name, last_name, referral_code, referred_by_user_id, start_parameter)
       VALUES (
         $1::bigint, $2, $3, $4, 'tg' || $1::text,
         (SELECT id FROM users WHERE referral_code = $5 AND telegram_id <> $1::bigint), $6
       )
       ON CONFLICT (telegram_id) DO NOTHING
       RETURNING id`,
      [profile.telegramId, profile.username ?? null, profile.firstName, profile.lastName ?? null, profile.referralCode ?? null, profile.startParameter ?? null],
    );

    if (inserted.rows[0]) {
      await this.recordReferralClick(profile);
      return { id: inserted.rows[0].id, telegramId: profile.telegramId, isFirstVisit: true };
    }

    const existing = await this.database.query<{ id: string }>(
      `UPDATE users
       SET username = $2,
           first_name = $3,
           last_name = $4,
           referral_code = COALESCE(referral_code, 'tg' || telegram_id::text),
           updated_at = now()
       WHERE telegram_id = $1
       RETURNING id`,
      [profile.telegramId, profile.username ?? null, profile.firstName, profile.lastName ?? null],
    );
    const user = existing.rows[0];

    if (!user) {
      throw new Error(`Could not load Telegram user ${profile.telegramId}.`);
    }

    await this.recordReferralClick(profile);
    return { id: user.id, telegramId: profile.telegramId, isFirstVisit: false };
  }

  async isActiveAdmin(telegramId: string): Promise<boolean> {
    const result = await this.database.query<{ is_admin: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM admins WHERE telegram_id = $1 AND is_active = true
       ) AS is_admin`,
      [telegramId],
    );

    return result.rows[0]?.is_admin ?? false;
  }

  async getPreferences(telegramId: string): Promise<UserPreferences> {
    const result = await this.database.query<{
      monthly_promotions: boolean;
      application_reminders: boolean;
      repeat_placement_messages: boolean;
      feedback_requests: boolean;
    }>(
      `SELECT monthly_promotions, application_reminders, repeat_placement_messages, feedback_requests
       FROM users WHERE telegram_id = $1`,
      [telegramId],
    );
    const row = result.rows[0];
    if (!row) throw new Error(`Could not load preferences for Telegram user ${telegramId}.`);
    return {
      monthlyPromotions: row.monthly_promotions,
      applicationReminders: row.application_reminders,
      repeatPlacementMessages: row.repeat_placement_messages,
      feedbackRequests: row.feedback_requests,
    };
  }

  async togglePreference(telegramId: string, preference: UserPreferenceKey): Promise<UserPreferences> {
    const columns: Record<UserPreferenceKey, string> = {
      monthlyPromotions: 'monthly_promotions',
      applicationReminders: 'application_reminders',
      repeatPlacementMessages: 'repeat_placement_messages',
      feedbackRequests: 'feedback_requests',
    };
    const column = columns[preference];
    await this.database.query(
      `UPDATE users SET ${column} = NOT ${column},
         notification_settings_unlocked = notification_settings_unlocked OR NOT ${column},
         updated_at = now() WHERE telegram_id = $1`,
      [telegramId],
    );
    return this.getPreferences(telegramId);
  }

  async disableAdvertisingMessages(telegramId: string): Promise<UserPreferences> {
    await this.database.query(
      `UPDATE users
       SET monthly_promotions = false,
           application_reminders = false,
           repeat_placement_messages = false,
           updated_at = now()
       WHERE telegram_id = $1`,
      [telegramId],
    );
    return this.getPreferences(telegramId);
  }

  async setMarketingConsent(telegramId: string, enabled: boolean): Promise<UserPreferences> {
    await this.database.query(
      `UPDATE users SET monthly_promotions = $2, application_reminders = $2,
         repeat_placement_messages = $2,
         notification_settings_unlocked = notification_settings_unlocked OR $2,
         updated_at = now()
       WHERE telegram_id = $1`,
      [telegramId, enabled],
    );
    return this.getPreferences(telegramId);
  }

  async setFeedbackConsent(telegramId: string, enabled: boolean): Promise<UserPreferences> {
    await this.database.query(
      `UPDATE users SET feedback_requests = $2,
         notification_settings_unlocked = notification_settings_unlocked OR $2,
         updated_at = now() WHERE telegram_id = $1`,
      [telegramId, enabled],
    );
    return this.getPreferences(telegramId);
  }

  async hasNotificationSettingsAccess(telegramId: string): Promise<boolean> {
    const result = await this.database.query<{ unlocked: boolean }>(
      `SELECT notification_settings_unlocked AS unlocked FROM users WHERE telegram_id = $1`,
      [telegramId],
    );
    return result.rows[0]?.unlocked ?? false;
  }

  async setPendingConsentOrder(telegramId: string, orderId: string): Promise<void> {
    await this.database.query(
      `UPDATE users SET pending_consent_order_id = $2,
         pending_marketing_consent_answered = false,
         pending_feedback_consent_answered = false,
         updated_at = now() WHERE telegram_id = $1`,
      [telegramId, orderId],
    );
  }

  async markPendingConsentAnswered(
    telegramId: string,
    category: 'marketing' | 'feedback',
  ): Promise<{ marketingAnswered: boolean; feedbackAnswered: boolean } | undefined> {
    const column = category === 'marketing'
      ? 'pending_marketing_consent_answered'
      : 'pending_feedback_consent_answered';
    const result = await this.database.query<{
      marketing_answered: boolean;
      feedback_answered: boolean;
    }>(
      `UPDATE users SET ${column} = true, updated_at = now()
       WHERE telegram_id = $1 AND pending_consent_order_id IS NOT NULL
       RETURNING pending_marketing_consent_answered AS marketing_answered,
         pending_feedback_consent_answered AS feedback_answered`,
      [telegramId],
    );
    const row = result.rows[0];
    return row ? { marketingAnswered: row.marketing_answered, feedbackAnswered: row.feedback_answered } : undefined;
  }

  async getPendingConsentOrder(telegramId: string): Promise<string | undefined> {
    const result = await this.database.query<{ order_id: string | null }>(
      `SELECT pending_consent_order_id AS order_id FROM users WHERE telegram_id = $1`,
      [telegramId],
    );
    return result.rows[0]?.order_id ?? undefined;
  }

  async clearPendingConsentOrder(telegramId: string): Promise<void> {
    await this.database.query(
      `UPDATE users SET pending_consent_order_id = NULL,
         pending_marketing_consent_answered = false,
         pending_feedback_consent_answered = false,
         updated_at = now() WHERE telegram_id = $1`,
      [telegramId],
    );
  }

  async canSendPromotionalMessage(telegramId: string, preference: UserPreferenceKey): Promise<boolean> {
    const columns: Record<UserPreferenceKey, string> = {
      monthlyPromotions: 'monthly_promotions',
      applicationReminders: 'application_reminders',
      repeatPlacementMessages: 'repeat_placement_messages',
      feedbackRequests: 'feedback_requests',
    };
    const result = await this.database.query<{ enabled: boolean }>(
      `SELECT ${columns[preference]} AS enabled FROM users WHERE telegram_id = $1`,
      [telegramId],
    );
    return result.rows[0]?.enabled ?? false;
  }

  async syncConfiguredAdmins(telegramIds: readonly string[]): Promise<void> {
    const client = await this.database.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `UPDATE admins SET is_active = false, updated_at = now()
         WHERE is_active = true AND NOT (telegram_id = ANY($1::bigint[]))`,
        [telegramIds],
      );

      if (telegramIds.length > 0) {
        await client.query(
          `INSERT INTO admins (telegram_id, is_active)
           SELECT configured_id::bigint, true FROM unnest($1::text[]) AS configured_ids(configured_id)
           ON CONFLICT (telegram_id) DO UPDATE SET is_active = true, updated_at = now()`,
          [telegramIds],
        );
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  private async recordReferralClick(profile: TelegramProfile): Promise<void> {
    if (!profile.referralCode) return;

    await this.database.query(
      `INSERT INTO referral_clicks (referrer_user_id, visitor_telegram_id)
       SELECT id, $2::bigint FROM users
       WHERE referral_code = $1 AND telegram_id <> $2::bigint`,
      [profile.referralCode, profile.telegramId],
    );
  }
}
