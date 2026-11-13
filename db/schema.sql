-- Минимальная стартовая схема Telegram-бота продаж.
-- СУБД: PostgreSQL.
-- Применение: psql "$DATABASE_URL" -f db/schema.sql

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Telegram-пользователи бота.
CREATE TABLE IF NOT EXISTS users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  telegram_id bigint NOT NULL UNIQUE,
  username text,
  first_name text,
  last_name text,
  referral_code text UNIQUE,
  referred_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  start_parameter text,
  monthly_promotions boolean NOT NULL DEFAULT false,
  application_reminders boolean NOT NULL DEFAULT false,
  repeat_placement_messages boolean NOT NULL DEFAULT false,
  feedback_requests boolean NOT NULL DEFAULT false,
  notification_settings_unlocked boolean NOT NULL DEFAULT false,
  pending_consent_order_id text,
  pending_marketing_consent_answered boolean NOT NULL DEFAULT false,
  pending_feedback_consent_answered boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE users ADD COLUMN IF NOT EXISTS referral_code text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS referred_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE users ADD COLUMN IF NOT EXISTS start_parameter text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS monthly_promotions boolean NOT NULL DEFAULT false;
ALTER TABLE users ADD COLUMN IF NOT EXISTS application_reminders boolean NOT NULL DEFAULT false;
ALTER TABLE users ADD COLUMN IF NOT EXISTS repeat_placement_messages boolean NOT NULL DEFAULT false;
ALTER TABLE users ADD COLUMN IF NOT EXISTS feedback_requests boolean NOT NULL DEFAULT false;
ALTER TABLE users ADD COLUMN IF NOT EXISTS notification_settings_unlocked boolean NOT NULL DEFAULT false;
ALTER TABLE users ADD COLUMN IF NOT EXISTS pending_consent_order_id text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS pending_marketing_consent_answered boolean NOT NULL DEFAULT false;
ALTER TABLE users ADD COLUMN IF NOT EXISTS pending_feedback_consent_answered boolean NOT NULL DEFAULT false;
ALTER TABLE users ALTER COLUMN monthly_promotions SET DEFAULT false;
ALTER TABLE users ALTER COLUMN application_reminders SET DEFAULT false;
ALTER TABLE users ALTER COLUMN repeat_placement_messages SET DEFAULT false;
ALTER TABLE users ALTER COLUMN feedback_requests SET DEFAULT false;
ALTER TABLE users ALTER COLUMN notification_settings_unlocked SET DEFAULT false;
UPDATE users SET notification_settings_unlocked = true
WHERE NOT notification_settings_unlocked
  AND (monthly_promotions OR application_reminders OR repeat_placement_messages OR feedback_requests);
CREATE TABLE IF NOT EXISTS schema_migrations (
  version text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM schema_migrations WHERE version = 'user_marketing_preferences_opt_in_v1') THEN
    UPDATE users
    SET monthly_promotions = false,
        application_reminders = false,
        repeat_placement_messages = false;
    INSERT INTO schema_migrations (version) VALUES ('user_marketing_preferences_opt_in_v1');
  END IF;
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS users_referral_code_unique_idx ON users (referral_code) WHERE referral_code IS NOT NULL;

-- Состояние анкеты хранится в БД, поэтому незавершённый диалог переживает перезапуск бота.
CREATE TABLE IF NOT EXISTS user_flows (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  flow_type text NOT NULL CHECK (flow_type IN ('advertiser_onboarding', 'question', 'contact_update')),
  step integer NOT NULL DEFAULT 0 CHECK (step >= 0),
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE user_flows DROP CONSTRAINT IF EXISTS user_flows_flow_type_check;
ALTER TABLE user_flows ADD CONSTRAINT user_flows_flow_type_check
  CHECK (flow_type IN ('advertiser_onboarding', 'question', 'contact_update'));

CREATE TABLE IF NOT EXISTS referral_clicks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  referrer_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  visitor_telegram_id bigint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS referral_clicks_referrer_created_idx
  ON referral_clicks (referrer_user_id, created_at DESC);

-- Реферальные бонусы
CREATE TABLE IF NOT EXISTS referral_bonuses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  referrer_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  invited_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  order_id uuid,
  amount numeric(12, 2) NOT NULL DEFAULT 0 CHECK (amount >= 0),
  used_amount numeric(12, 2) NOT NULL DEFAULT 0 CHECK (used_amount >= 0),
  currency char(3) NOT NULL DEFAULT 'EUR',
  expires_at timestamptz,
  status text NOT NULL DEFAULT 'accrued' CHECK (status IN ('accrued', 'used', 'cancelled')),
  note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS referral_bonuses_referrer_idx ON referral_bonuses (referrer_user_id);
CREATE INDEX IF NOT EXISTS referral_bonuses_invited_idx ON referral_bonuses (invited_user_id);
CREATE UNIQUE INDEX IF NOT EXISTS referral_bonuses_invited_order_unique_idx
  ON referral_bonuses (invited_user_id) WHERE order_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS referral_program_settings (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  bonus_amount numeric(12, 2) NOT NULL DEFAULT 0 CHECK (bonus_amount >= 0),
  currency char(3) NOT NULL DEFAULT 'EUR',
  validity_days integer CHECK (validity_days IS NULL OR validity_days > 0),
  combine_with_first_discount boolean NOT NULL DEFAULT false,
  eligible_tariff_ids uuid[],
  is_active boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE referral_bonuses ADD COLUMN IF NOT EXISTS expires_at timestamptz;
INSERT INTO referral_program_settings (singleton) VALUES (true) ON CONFLICT (singleton) DO NOTHING;

-- Администраторы, которые могут подтверждать заказы и оплату.
CREATE TABLE IF NOT EXISTS admins (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  telegram_id bigint NOT NULL UNIQUE,
  username text,
  first_name text,
  last_name text,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS admin_flows (
  admin_id uuid PRIMARY KEY REFERENCES admins(id) ON DELETE CASCADE,
  flow_type text NOT NULL CHECK (flow_type IN (
    'tariff_create', 'tariff_edit', 'message_user', 'filter_business', 'schedule_order', 'publish_order', 'referral_bonus_settings', 'edit_publication_date', 'promotional_broadcast'
  )),
  step integer NOT NULL DEFAULT 0 CHECK (step >= 0),
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE admin_flows DROP CONSTRAINT IF EXISTS admin_flows_flow_type_check;
ALTER TABLE admin_flows ADD CONSTRAINT admin_flows_flow_type_check
  CHECK (flow_type IN ('tariff_create', 'tariff_edit', 'message_user', 'filter_business', 'schedule_order', 'publish_order', 'referral_bonus_settings', 'edit_publication_date', 'promotional_broadcast'));

CREATE TABLE IF NOT EXISTS admin_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_id uuid NOT NULL REFERENCES admins(id) ON DELETE RESTRICT,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  message text NOT NULL,
  sent_at timestamptz NOT NULL DEFAULT now()
);

-- Scheduled promotional broadcasts survive application restarts. A job moves
-- from pending to sending in one atomic claim, so multiple bot processes never
-- deliver the same job. Sending jobs are intentionally not reclaimed after an
-- uncertain process failure: Telegram has no idempotency key for messages.
CREATE TABLE IF NOT EXISTS scheduled_promotional_broadcasts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_telegram_id bigint NOT NULL,
  message_text text NOT NULL CHECK (length(btrim(message_text)) > 0),
  media jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(media) = 'array'),
  scheduled_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'sending', 'sent', 'cancelled')),
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  completed_at timestamptz
);
CREATE INDEX IF NOT EXISTS scheduled_promotional_broadcasts_due_idx
  ON scheduled_promotional_broadcasts (scheduled_at, created_at)
  WHERE status = 'pending';

-- Единственное обновляемое сообщение сводки для каждого администратора.
CREATE TABLE IF NOT EXISTS admin_inbox_messages (
  admin_id uuid PRIMARY KEY REFERENCES admins(id) ON DELETE CASCADE,
  message_id integer NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Бизнесы / проекты пользователя. У пользователя может быть несколько бизнесов.
CREATE TABLE IF NOT EXISTS businesses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  name text NOT NULL,
  industry text,
  region text,
  website_url text,
  contact_name text,
  contact_value text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- Уникальность пары нужна, чтобы заказ нельзя было связать с чужим бизнесом.
  UNIQUE (id, user_id)
);
CREATE INDEX IF NOT EXISTS businesses_user_created_idx ON businesses (user_id, created_at DESC);
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS requested_placement text;

-- Вопросы рекламодателей для последующей передачи администраторам.
CREATE TABLE IF NOT EXISTS inquiries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  topic text NOT NULL,
  message text NOT NULL,
  source text NOT NULL DEFAULT 'organic',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS inquiries_user_created_idx ON inquiries (user_id, created_at DESC);

-- Доступные тарифы. Архивные записи скрываются от клиентов и администраторов.
CREATE TABLE IF NOT EXISTS tariffs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  platforms text NOT NULL DEFAULT '',
  inclusions text NOT NULL DEFAULT '',
  publication_count integer CHECK (publication_count IS NULL OR publication_count > 0),
  placement_duration text NOT NULL DEFAULT '',
  feedback_delay_days integer NOT NULL DEFAULT 14 CHECK (feedback_delay_days > 0),
  description text NOT NULL DEFAULT '',
  price numeric(12, 2) NOT NULL CHECK (price >= 0),
  currency char(3) NOT NULL DEFAULT 'EUR',
  discount_valid_until date,
  is_active boolean NOT NULL DEFAULT true,
  is_archived boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE tariffs ADD COLUMN IF NOT EXISTS platforms text NOT NULL DEFAULT '';
ALTER TABLE tariffs ADD COLUMN IF NOT EXISTS inclusions text NOT NULL DEFAULT '';
ALTER TABLE tariffs ADD COLUMN IF NOT EXISTS publication_count integer;
ALTER TABLE tariffs ADD COLUMN IF NOT EXISTS placement_duration text NOT NULL DEFAULT '';
ALTER TABLE tariffs ADD COLUMN IF NOT EXISTS feedback_delay_days integer NOT NULL DEFAULT 14;
ALTER TABLE tariffs ADD COLUMN IF NOT EXISTS discount_valid_until date;
ALTER TABLE tariffs ADD COLUMN IF NOT EXISTS is_archived boolean NOT NULL DEFAULT false;
ALTER TABLE tariffs DROP CONSTRAINT IF EXISTS tariffs_publication_count_check;
ALTER TABLE tariffs ADD CONSTRAINT tariffs_publication_count_check
  CHECK (publication_count IS NULL OR publication_count > 0);
ALTER TABLE tariffs DROP CONSTRAINT IF EXISTS tariffs_feedback_delay_days_check;
ALTER TABLE tariffs ADD CONSTRAINT tariffs_feedback_delay_days_check
  CHECK (feedback_delay_days > 0);

-- Актуальный каталог рекламы. Старые тарифы отключаются, чтобы сохранить
-- историю заказов; каталог обновляется только один раз при первой инициализации.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM schema_migrations WHERE version = 'public_tariff_catalog_2026_11_10_v1') THEN
    UPDATE tariffs SET is_active = false, is_archived = true, updated_at = now() WHERE is_active = true;

    INSERT INTO tariffs (
      name, platforms, inclusions, publication_count, placement_duration,
      feedback_delay_days, description, price, currency, is_active
    ) VALUES
      (
        '1 пост без закрепа', '', 'Один рекламный пост; без закрепа и без удаления.',
        1, 'Один пост', 14, '', 10, 'EUR', true
      ),
      (
        '1 пост с закрепом', '', 'Один рекламный пост с закрепом.',
        1, 'Один пост', 14, '', 15, 'EUR', true
      ),
      (
        '4 поста за месяц', '', 'Четыре рекламных поста в течение месяца.',
        4, '1 месяц', 14, '', 30, 'EUR', true
      ),
      (
        'Проверенный специалист — 1 месяц', '',
        'Ежедневное сообщение в чате, FAQ, статьи и другие форматы.',
        NULL, '1 месяц', 14,
        'В течение срока рекламы других специалистов вашей ниши не будет. Подробности можно уточнить у администратора.',
        50, 'EUR', true
      ),
      (
        'Проверенный специалист — 3 месяца', '',
        'Ежедневное сообщение в чате, FAQ, статьи и другие форматы.',
        NULL, '3 месяца', 14,
        'В течение срока рекламы других специалистов вашей ниши не будет. Подробности можно уточнить у администратора.',
        135, 'EUR', true
      ),
      (
        'Проверенный специалист — 6 месяцев', '',
        'Ежедневное сообщение в чате, FAQ, статьи и другие форматы.',
        NULL, '6 месяцев', 14,
        'В течение срока рекламы других специалистов вашей ниши не будет. Подробности можно уточнить у администратора.',
        250, 'EUR', true
      ),
      (
        'Проверенный специалист — 12 месяцев', '',
        'Ежедневное сообщение в чате, FAQ, статьи и другие форматы.',
        NULL, '12 месяцев', 14,
        'В течение срока рекламы других специалистов вашей ниши не будет. Подробности можно уточнить у администратора.',
        480, 'EUR', true
      );

    INSERT INTO schema_migrations (version) VALUES ('public_tariff_catalog_2026_11_10_v1');
  END IF;
END $$;

-- Заказ создаётся пользователем и ожидает решения администратора.
-- Снимки тарифа и цены сохраняют условия на момент оформления заказа.
CREATE TABLE IF NOT EXISTS orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_number bigint NOT NULL DEFAULT (10000000 + floor(random() * 90000000)::bigint) UNIQUE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  business_id uuid NOT NULL,
  tariff_id uuid NOT NULL REFERENCES tariffs(id) ON DELETE RESTRICT,
  status text NOT NULL DEFAULT 'pending_confirmation' CHECK (status IN (
    'pending_confirmation', 'confirmed', 'rejected', 'cancelled', 'completed'
  )),
  tariff_name_snapshot text NOT NULL,
  tariff_description_snapshot text NOT NULL DEFAULT '',
  feedback_delay_days_snapshot integer NOT NULL DEFAULT 14 CHECK (feedback_delay_days_snapshot > 0),
  price numeric(12, 2) NOT NULL CHECK (price >= 0),
  price_before_discount numeric(12, 2) NOT NULL DEFAULT 0 CHECK (price_before_discount >= 0),
  discount_amount numeric(12, 2) NOT NULL DEFAULT 0 CHECK (discount_amount >= 0),
  currency char(3) NOT NULL DEFAULT 'EUR',
  user_comment text,
  publication_dates text[] NOT NULL DEFAULT '{}',
  publication_date_statuses text[] NOT NULL DEFAULT '{}',
  publication_statuses text[] NOT NULL DEFAULT '{}',
  publication_published_at timestamptz[] NOT NULL DEFAULT '{}',
  publication_links text[] NOT NULL DEFAULT '{}',
  confirmed_by_admin_id uuid REFERENCES admins(id) ON DELETE RESTRICT,
  confirmed_at timestamptz,
  rejected_by_admin_id uuid REFERENCES admins(id) ON DELETE RESTRICT,
  rejected_at timestamptz,
  admin_comment text,
  publication_at timestamptz,
  published_at timestamptz,
  publication_link text,
  feedback_due_at timestamptz,
  feedback_claimed_at timestamptz,
  feedback_sent_at timestamptz,
  feedback_response text CHECK (feedback_response IS NULL OR feedback_response IN ('good', 'discuss', 'repeat')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT order_confirmation_fields CHECK (
    (status NOT IN ('confirmed', 'completed') OR
      (confirmed_by_admin_id IS NOT NULL AND confirmed_at IS NOT NULL)) AND
    (status <> 'rejected' OR
      (rejected_by_admin_id IS NOT NULL AND rejected_at IS NOT NULL))
  ),
  FOREIGN KEY (business_id, user_id) REFERENCES businesses(id, user_id) ON DELETE RESTRICT
);
-- Номер заказа должен быть случайным восьмизначным ID, а не счётчиком.
-- Эти ALTER-команды также переводят на новый формат уже существующую таблицу.
ALTER TABLE orders ALTER COLUMN order_number DROP IDENTITY IF EXISTS;
ALTER TABLE orders ALTER COLUMN order_number SET DEFAULT (10000000 + floor(random() * 90000000)::bigint);
DO $$
DECLARE
  order_row record;
  candidate bigint;
BEGIN
  FOR order_row IN
    SELECT id FROM orders WHERE order_number < 10000000 OR order_number > 99999999
  LOOP
    LOOP
      candidate := 10000000 + floor(random() * 90000000)::bigint;
      BEGIN
        UPDATE orders SET order_number = candidate WHERE id = order_row.id;
        EXIT;
      EXCEPTION WHEN unique_violation THEN
        -- При совпадении генерируем другой номер и пробуем ещё раз.
      END;
    END LOOP;
  END LOOP;
END;
$$;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS publication_at timestamptz;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS publication_dates text[] NOT NULL DEFAULT '{}';
ALTER TABLE orders ADD COLUMN IF NOT EXISTS publication_date_statuses text[] NOT NULL DEFAULT '{}';
UPDATE orders AS order_record SET publication_dates = CASE
  WHEN order_record.user_comment LIKE 'Даты публикаций:%'
    THEN regexp_split_to_array(BTRIM(substr(order_record.user_comment, length('Даты публикаций:') + 1)), ',[[:space:]]*')
  WHEN order_record.user_comment ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN ARRAY[order_record.user_comment]
  ELSE ARRAY(SELECT ''::text FROM generate_series(1, COALESCE(tariff.publication_count, 1)))
END
FROM tariffs AS tariff
WHERE tariff.id = order_record.tariff_id AND cardinality(order_record.publication_dates) = 0;
UPDATE orders AS order_record SET publication_date_statuses = ARRAY(
  SELECT CASE WHEN date.value = '' THEN 'awaiting_admin'::text ELSE 'confirmed'::text END
  FROM unnest(order_record.publication_dates) WITH ORDINALITY AS date(value, position)
  ORDER BY date.position
)
WHERE cardinality(order_record.publication_date_statuses) <> cardinality(order_record.publication_dates);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS feedback_delay_days_snapshot integer NOT NULL DEFAULT 14;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS published_at timestamptz;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS publication_link text;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS publication_statuses text[] NOT NULL DEFAULT '{}';
ALTER TABLE orders ADD COLUMN IF NOT EXISTS publication_published_at timestamptz[] NOT NULL DEFAULT '{}';
ALTER TABLE orders ADD COLUMN IF NOT EXISTS publication_links text[] NOT NULL DEFAULT '{}';
UPDATE orders AS order_record SET
  publication_statuses = ARRAY(
    SELECT CASE WHEN order_record.status = 'completed' AND order_record.published_at IS NOT NULL THEN 'published'::text ELSE 'pending'::text END
    FROM generate_series(1, cardinality(order_record.publication_dates))
  ),
  publication_published_at = ARRAY(
    SELECT CASE WHEN order_record.status = 'completed' THEN order_record.published_at ELSE NULL::timestamptz END
    FROM generate_series(1, cardinality(order_record.publication_dates))
  ),
  publication_links = ARRAY(
    SELECT CASE WHEN order_record.status = 'completed' THEN order_record.publication_link ELSE NULL::text END
    FROM generate_series(1, cardinality(order_record.publication_dates))
  )
WHERE cardinality(order_record.publication_dates) > 0 AND cardinality(order_record.publication_statuses) = 0;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS feedback_due_at timestamptz;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS feedback_claimed_at timestamptz;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS feedback_sent_at timestamptz;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS feedback_response text;
ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_feedback_delay_days_snapshot_check;
ALTER TABLE orders ADD CONSTRAINT orders_feedback_delay_days_snapshot_check
  CHECK (feedback_delay_days_snapshot > 0);
ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_feedback_response_check;
ALTER TABLE orders ADD CONSTRAINT orders_feedback_response_check
  CHECK (feedback_response IS NULL OR feedback_response IN ('good', 'discuss', 'repeat'));
ALTER TABLE orders ADD COLUMN IF NOT EXISTS price_before_discount numeric(12, 2) NOT NULL DEFAULT 0;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS discount_amount numeric(12, 2) NOT NULL DEFAULT 0;
ALTER TABLE referral_bonuses ADD COLUMN IF NOT EXISTS order_id uuid;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'referral_bonuses_order_id_fkey'
      AND conrelid = 'referral_bonuses'::regclass
  ) THEN
    ALTER TABLE referral_bonuses ADD CONSTRAINT referral_bonuses_order_id_fkey
      FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE SET NULL;
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS orders_user_created_idx ON orders (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS orders_status_created_idx ON orders (status, created_at DESC);

CREATE TABLE IF NOT EXISTS order_feedback (
  order_id uuid PRIMARY KEY REFERENCES orders(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  response text NOT NULL CHECK (response IN ('good', 'discuss', 'repeat')),
  review_text text,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO order_feedback (order_id, user_id, response, status)
SELECT order_record.id, order_record.user_id, order_record.feedback_response,
  CASE WHEN order_record.feedback_response = 'discuss' THEN 'open' ELSE 'closed' END
FROM orders AS order_record
WHERE order_record.feedback_response IS NOT NULL
ON CONFLICT (order_id) DO NOTHING;
CREATE INDEX IF NOT EXISTS order_feedback_created_idx ON order_feedback (created_at DESC);
CREATE INDEX IF NOT EXISTS order_feedback_response_status_idx ON order_feedback (response, status, created_at DESC);

CREATE TABLE IF NOT EXISTS order_feedback_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL REFERENCES order_feedback(order_id) ON DELETE CASCADE,
  sender_type text NOT NULL CHECK (sender_type IN ('user', 'admin')),
  sender_telegram_id bigint NOT NULL,
  message text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS order_feedback_messages_order_created_idx ON order_feedback_messages (order_id, created_at);

CREATE TABLE IF NOT EXISTS feedback_reply_sessions (
  telegram_id bigint PRIMARY KEY,
  order_id uuid NOT NULL REFERENCES order_feedback(order_id) ON DELETE CASCADE,
  sender_type text NOT NULL CHECK (sender_type IN ('user', 'admin')),
  mode text NOT NULL CHECK (mode IN ('review', 'message')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS order_drafts (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  tariff_id uuid NOT NULL REFERENCES tariffs(id) ON DELETE RESTRICT,
  status text NOT NULL DEFAULT 'awaiting_date' CHECK (status IN ('awaiting_date', 'ready')),
  preferred_date text,
  publication_dates text[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE order_drafts ADD COLUMN IF NOT EXISTS publication_dates text[] NOT NULL DEFAULT '{}';
UPDATE order_drafts SET publication_dates = ARRAY[preferred_date]
WHERE preferred_date IS NOT NULL AND cardinality(publication_dates) = 0;
UPDATE order_drafts AS draft SET publication_dates = ARRAY(
  SELECT CASE WHEN series.index = 1 THEN COALESCE(draft.preferred_date, draft.publication_dates[1], '') ELSE '' END
  FROM generate_series(1, COALESCE(tariff.publication_count, 1)) AS series(index)
)
FROM tariffs AS tariff
WHERE tariff.id = draft.tariff_id AND cardinality(draft.publication_dates) <> COALESCE(tariff.publication_count, 1);
UPDATE order_drafts SET status = 'awaiting_date'
WHERE cardinality(publication_dates) > 1
  AND array_position(array_replace(publication_dates, ''::text, NULL), NULL) IS NOT NULL;

-- Фиксация заявленной оплаты. Запись создаётся, когда пользователь сообщает,
-- что оплатил заказ; статус меняет только администратор.
-- Внешняя платёжная система и автоматическое подтверждение пока не используются.
CREATE TABLE IF NOT EXISTS payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL UNIQUE REFERENCES orders(id) ON DELETE RESTRICT,
  amount numeric(12, 2) NOT NULL CHECK (amount >= 0),
  currency char(3) NOT NULL DEFAULT 'EUR',
  payment_method text NOT NULL DEFAULT 'не указан',
  proof_file_id text,
  status text NOT NULL DEFAULT 'pending_approval' CHECK (status IN (
    'pending_approval', 'approved', 'rejected'
  )),
  user_reported_at timestamptz NOT NULL DEFAULT now(),
  reviewed_by_admin_id uuid REFERENCES admins(id) ON DELETE RESTRICT,
  reviewed_at timestamptz,
  admin_comment text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT payment_review_fields CHECK (
    (status = 'pending_approval' AND reviewed_by_admin_id IS NULL AND reviewed_at IS NULL) OR
    (status IN ('approved', 'rejected') AND reviewed_by_admin_id IS NOT NULL AND reviewed_at IS NOT NULL)
  )
);
ALTER TABLE payments ADD COLUMN IF NOT EXISTS payment_method text NOT NULL DEFAULT 'не указан';
ALTER TABLE payments ADD COLUMN IF NOT EXISTS proof_file_id text;
CREATE INDEX IF NOT EXISTS payments_status_created_idx ON payments (status, created_at DESC);

CREATE TABLE IF NOT EXISTS payment_method_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL REFERENCES orders(id) ON DELETE RESTRICT,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  request_kind text NOT NULL DEFAULT 'alternative' CHECK (request_kind IN ('alternative', 'problem')),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'answered')),
  message text,
  created_at timestamptz NOT NULL DEFAULT now(),
  answered_at timestamptz
);
ALTER TABLE payment_method_requests ADD COLUMN IF NOT EXISTS message text;
ALTER TABLE payment_method_requests ADD COLUMN IF NOT EXISTS request_kind text NOT NULL DEFAULT 'alternative';
CREATE INDEX IF NOT EXISTS payment_method_requests_created_idx ON payment_method_requests (status, created_at DESC);

CREATE TABLE IF NOT EXISTS payment_proof_requests (
  order_id uuid PRIMARY KEY REFERENCES orders(id) ON DELETE CASCADE,
  payment_method text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Напоминание рекламодателю, который открыл оплату, но не сообщил об оплате.
CREATE TABLE IF NOT EXISTS payment_checkout_reminders (
  order_id uuid PRIMARY KEY REFERENCES orders(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  due_at timestamptz NOT NULL,
  sent_at timestamptz,
  claimed_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS payment_checkout_reminders_due_idx
  ON payment_checkout_reminders (due_at) WHERE sent_at IS NULL;

-- Рекламные материалы собираются после подтверждения оплаты и связаны с конкретным заказом.
CREATE TABLE IF NOT EXISTS order_material_submissions (
  order_id uuid PRIMARY KEY REFERENCES orders(id) ON DELETE RESTRICT,
  status text NOT NULL DEFAULT 'collecting' CHECK (status IN ('collecting', 'submitted', 'approved', 'rejected')),
  is_paused boolean NOT NULL DEFAULT false,
  step smallint NOT NULL DEFAULT 0 CHECK (step BETWEEN 0 AND 6),
  revision_mode boolean NOT NULL DEFAULT false,
  review_mode boolean NOT NULL DEFAULT false,
  reused_from_order_id uuid REFERENCES orders(id) ON DELETE SET NULL,
  ad_text text,
  media jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(media) = 'array'),
  destination text,
  publication_date text,
  wishes text,
  admin_comment text,
  submitted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT order_material_submission_state CHECK (
    (status = 'collecting' AND submitted_at IS NULL) OR
    (status IN ('submitted', 'approved', 'rejected') AND submitted_at IS NOT NULL)
  )
);
ALTER TABLE order_material_submissions ADD COLUMN IF NOT EXISTS is_paused boolean NOT NULL DEFAULT false;
ALTER TABLE order_material_submissions ADD COLUMN IF NOT EXISTS revision_mode boolean NOT NULL DEFAULT false;
ALTER TABLE order_material_submissions ADD COLUMN IF NOT EXISTS review_mode boolean NOT NULL DEFAULT false;
ALTER TABLE order_material_submissions ADD COLUMN IF NOT EXISTS reused_from_order_id uuid REFERENCES orders(id) ON DELETE SET NULL;
ALTER TABLE order_material_submissions ADD COLUMN IF NOT EXISTS admin_comment text;
ALTER TABLE order_material_submissions DROP CONSTRAINT IF EXISTS order_material_submissions_step_check;
ALTER TABLE order_material_submissions ADD CONSTRAINT order_material_submissions_step_check
  CHECK (step BETWEEN 0 AND 6);
ALTER TABLE order_material_submissions DROP CONSTRAINT IF EXISTS order_material_submissions_status_check;
ALTER TABLE order_material_submissions
  ADD CONSTRAINT order_material_submissions_status_check
  CHECK (status IN ('collecting', 'submitted', 'approved', 'rejected'));
ALTER TABLE order_material_submissions DROP CONSTRAINT IF EXISTS order_material_submission_state;
ALTER TABLE order_material_submissions
  ADD CONSTRAINT order_material_submission_state CHECK (
    (status = 'collecting' AND submitted_at IS NULL) OR
    (status IN ('submitted', 'approved', 'rejected') AND submitted_at IS NOT NULL)
  );
UPDATE order_material_submissions SET step = 3
WHERE status = 'collecting' AND revision_mode = false AND step = 4;
CREATE INDEX IF NOT EXISTS order_material_status_updated_idx
  ON order_material_submissions (status, updated_at DESC);

-- Скрыть старый каталог и физически убрать тарифы, не связанные с заказами.
-- Ссылки из истории заказов оставляем для целостности и показываем в БД только как архив.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM schema_migrations WHERE version = 'compact_tariff_catalog_cleanup_v1') THEN
    UPDATE tariffs SET name = '1 пост без закрепа', updated_at = now()
      WHERE name = '1 пост без закрепа — 10 €';
    UPDATE tariffs SET name = '1 пост с закрепом', updated_at = now()
      WHERE name = '1 пост с закрепом — 15 €';
    UPDATE tariffs SET name = '4 поста за месяц', updated_at = now()
      WHERE name = '4 поста за месяц — 30 €';

    UPDATE tariffs SET is_active = false, is_archived = true, updated_at = now()
    WHERE name NOT IN (
      '1 пост без закрепа',
      '1 пост с закрепом',
      '4 поста за месяц',
      'Проверенный специалист — 1 месяц',
      'Проверенный специалист — 3 месяца',
      'Проверенный специалист — 6 месяцев',
      'Проверенный специалист — 12 месяцев'
    );

    DELETE FROM order_drafts AS draft
    USING tariffs AS tariff
    WHERE draft.tariff_id = tariff.id AND tariff.is_archived = true;

    DELETE FROM tariffs AS tariff
    WHERE tariff.is_archived = true
      AND NOT EXISTS (SELECT 1 FROM orders WHERE orders.tariff_id = tariff.id);

    INSERT INTO schema_migrations (version) VALUES ('compact_tariff_catalog_cleanup_v1');
  END IF;
END $$;
