-- ============================================================
-- SubTrack initial schema
-- ============================================================
-- Conventions used throughout:
--   * UUID primary keys (gen_random_uuid from pgcrypto) so ids can be
--     generated client-side and are safe to expose in URLs.
--   * `citext` for e-mail so lookups are case-insensitive without
--     scattering lower() around every query.
--   * Money as numeric(12,2). Never float: 0.1 + 0.2 problems in a
--     billing app are not acceptable.
--   * Calendar dates (renewal_date, payment_date) as `date`, not
--     timestamptz — a renewal on the 14th is the 14th in every timezone.
--   * ON DELETE CASCADE from users downward so account deletion is one
--     statement and cannot leave orphaned personal data behind.

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS citext;

-- Keeps updated_at honest without relying on every code path to set it.
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ── Users ────────────────────────────────────────────────────
CREATE TABLE users (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email           citext NOT NULL UNIQUE,
  password_hash   text   NOT NULL,
  name            text   NOT NULL,
  avatar_url      text,
  currency        char(3) NOT NULL DEFAULT 'USD',
  locale          text    NOT NULL DEFAULT 'en',
  timezone        text    NOT NULL DEFAULT 'UTC',
  email_verified  boolean NOT NULL DEFAULT false,
  monthly_budget  numeric(12,2),
  -- Free-form personalisation for the AI engine: tone, insight cadence,
  -- which nudges the user opted out of, learned category preferences.
  preferences     jsonb   NOT NULL DEFAULT '{}'::jsonb,
  last_login_at   timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT users_email_shape CHECK (position('@' in email) > 1),
  CONSTRAINT users_budget_positive CHECK (monthly_budget IS NULL OR monthly_budget >= 0)
);
CREATE TRIGGER users_updated_at BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Single-use tokens for e-mail verification and password reset.
-- Only the SHA-256 hash is stored, so a database leak cannot be replayed
-- to take over accounts.
CREATE TABLE auth_tokens (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind        text NOT NULL CHECK (kind IN ('verify_email', 'reset_password')),
  token_hash  text NOT NULL,
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX auth_tokens_lookup ON auth_tokens (token_hash) WHERE used_at IS NULL;
CREATE INDEX auth_tokens_user ON auth_tokens (user_id, kind);

-- Refresh tokens are tracked server-side so "log out everywhere" and
-- per-device revocation actually work.
CREATE TABLE refresh_tokens (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash  text NOT NULL UNIQUE,
  user_agent  text,
  expires_at  timestamptz NOT NULL,
  revoked_at  timestamptz,
  -- Why the token stopped being valid. This distinction is load-bearing:
  -- replaying a token revoked by 'rotation' means the token leaked (the
  -- real client already exchanged it), which warrants killing every
  -- session. Replaying one revoked by 'logout' just means a stale client,
  -- and must NOT log the user out of their other devices.
  revoked_reason text CHECK (revoked_reason IN
                    ('rotated','logout','logout_all','password_change','breach')),
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX refresh_tokens_user ON refresh_tokens (user_id) WHERE revoked_at IS NULL;

-- ── Categories ───────────────────────────────────────────────
CREATE TABLE categories (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name        text NOT NULL,
  color       text NOT NULL DEFAULT '#4f46e5',
  icon        text NOT NULL DEFAULT 'tag',
  is_default  boolean NOT NULL DEFAULT false,
  sort_order  integer NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT categories_color_hex CHECK (color ~* '^#[0-9a-f]{6}$')
);
-- Category names are unique per user, case-insensitively.
CREATE UNIQUE INDEX categories_user_name ON categories (user_id, lower(name));
CREATE TRIGGER categories_updated_at BEFORE UPDATE ON categories
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ── Subscriptions ────────────────────────────────────────────
CREATE TABLE subscriptions (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- Categories are set null rather than cascaded: deleting a category
  -- must never delete the user's spending history.
  category_id         uuid REFERENCES categories(id) ON DELETE SET NULL,
  name                text NOT NULL,
  description         text,
  -- Resolved id from the shared service catalogue (e.g. 'netflix'), used
  -- for market price comparison and overlap detection.
  vendor_id           text,
  subcategory         text,
  cost                numeric(12,2) NOT NULL,
  currency            char(3) NOT NULL DEFAULT 'USD',
  billing_cycle       text NOT NULL CHECK (billing_cycle IN
                        ('weekly','biweekly','monthly','quarterly','semiannual','yearly')),
  renewal_date        date NOT NULL,
  started_at          date,
  status              text NOT NULL DEFAULT 'active'
                        CHECK (status IN ('active','trial','paused','cancelled')),
  trial_ends_at       date,
  cancelled_at        date,
  auto_renew          boolean NOT NULL DEFAULT true,
  url                 text,
  notes               text,
  reminder_days_before integer NOT NULL DEFAULT 3,
  -- AI-maintained columns. usage_score/value_score are 0..100 so they can
  -- be rendered as a bar without further scaling.
  usage_score         numeric(5,2),
  value_score         numeric(5,2),
  ai_recommendation   text,
  ai_confidence       numeric(4,3),
  ai_reviewed_at      timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT subscriptions_cost_positive CHECK (cost >= 0),
  CONSTRAINT subscriptions_reminder_range CHECK (reminder_days_before BETWEEN 0 AND 60),
  CONSTRAINT subscriptions_scores_range CHECK (
    (usage_score IS NULL OR usage_score BETWEEN 0 AND 100) AND
    (value_score IS NULL OR value_score BETWEEN 0 AND 100)
  )
);
CREATE INDEX subscriptions_user_status ON subscriptions (user_id, status);
CREATE INDEX subscriptions_renewal ON subscriptions (renewal_date)
  WHERE status IN ('active','trial');
CREATE INDEX subscriptions_user_category ON subscriptions (user_id, category_id);
CREATE TRIGGER subscriptions_updated_at BEFORE UPDATE ON subscriptions
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ── Payment history ──────────────────────────────────────────
CREATE TABLE payment_history (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subscription_id uuid NOT NULL REFERENCES subscriptions(id) ON DELETE CASCADE,
  -- Denormalised user_id: every analytics query filters by user, and this
  -- avoids a join back through subscriptions on the hot path.
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  payment_date    date NOT NULL,
  amount          numeric(12,2) NOT NULL,
  currency        char(3) NOT NULL DEFAULT 'USD',
  status          text NOT NULL DEFAULT 'paid'
                    CHECK (status IN ('paid','pending','failed','refunded')),
  method          text,
  note            text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT payment_amount_positive CHECK (amount >= 0)
);
CREATE INDEX payment_history_user_date ON payment_history (user_id, payment_date DESC);
CREATE INDEX payment_history_subscription ON payment_history (subscription_id, payment_date DESC);

-- Price changes, so the optimiser can say "Netflix went up $2.50 in March".
CREATE TABLE price_history (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subscription_id uuid NOT NULL REFERENCES subscriptions(id) ON DELETE CASCADE,
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  old_cost        numeric(12,2) NOT NULL,
  new_cost        numeric(12,2) NOT NULL,
  old_cycle       text,
  new_cycle       text,
  changed_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX price_history_subscription ON price_history (subscription_id, changed_at DESC);

-- ── Usage analytics ──────────────────────────────────────────
-- One row per subscription (PK is the subscription id) holding the
-- rolled-up usage signal the recommendation engine reads.
CREATE TABLE usage_analytics (
  subscription_id  uuid PRIMARY KEY REFERENCES subscriptions(id) ON DELETE CASCADE,
  user_id          uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  last_used_at     timestamptz,
  uses_last_30d    integer NOT NULL DEFAULT 0,
  uses_last_90d    integer NOT NULL DEFAULT 0,
  frequency_score  numeric(5,2) NOT NULL DEFAULT 0,
  value_score      numeric(5,2) NOT NULL DEFAULT 0,
  cost_per_use     numeric(12,2),
  churn_risk       numeric(4,3),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT usage_counts_positive CHECK (uses_last_30d >= 0 AND uses_last_90d >= 0)
);
CREATE INDEX usage_analytics_user ON usage_analytics (user_id);
CREATE TRIGGER usage_analytics_updated_at BEFORE UPDATE ON usage_analytics
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Raw usage events. The rollup above is derived from these.
CREATE TABLE usage_events (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subscription_id uuid NOT NULL REFERENCES subscriptions(id) ON DELETE CASCADE,
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  occurred_at     timestamptz NOT NULL DEFAULT now(),
  source          text NOT NULL DEFAULT 'manual'
                    CHECK (source IN ('manual','desktop','web','import','estimate')),
  weight          numeric(4,2) NOT NULL DEFAULT 1
);
CREATE INDEX usage_events_subscription ON usage_events (subscription_id, occurred_at DESC);

-- ── AI insights ──────────────────────────────────────────────
CREATE TABLE ai_insights (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  insight_type      text NOT NULL CHECK (insight_type IN
                      ('savings','duplicate','unused','anomaly','forecast','trend',
                       'price_increase','bundle','renewal','summary','benchmark',
                       'recommendation')),
  severity          text NOT NULL DEFAULT 'info'
                      CHECK (severity IN ('info','low','medium','high')),
  title             text NOT NULL,
  content           text NOT NULL,
  -- Structured payload backing the card (chart series, ids, amounts).
  data              jsonb NOT NULL DEFAULT '{}'::jsonb,
  potential_savings numeric(12,2),
  -- Subscriptions this insight refers to. Kept as an array rather than a
  -- join table: insights are write-once and always read whole.
  related_subscription_ids uuid[] NOT NULL DEFAULT '{}',
  -- Which model produced it, or 'heuristic' when running without an API key.
  model             text,
  -- Stable hash of the insight's substance, used to avoid re-inserting the
  -- same advice every night.
  fingerprint       text,
  dismissed         boolean NOT NULL DEFAULT false,
  dismissed_at      timestamptz,
  generated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ai_insights_user_active ON ai_insights (user_id, generated_at DESC)
  WHERE dismissed = false;
CREATE UNIQUE INDEX ai_insights_fingerprint ON ai_insights (user_id, fingerprint)
  WHERE fingerprint IS NOT NULL;

-- ── Chat history ─────────────────────────────────────────────
CREATE TABLE chat_history (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- Groups messages into conversations so the assistant can scope context.
  session_id   uuid NOT NULL,
  sender       text NOT NULL CHECK (sender IN ('user','assistant','system')),
  message      text NOT NULL,
  -- Pending slot-filling state, tool calls made, entities extracted.
  context      jsonb NOT NULL DEFAULT '{}'::jsonb,
  tokens_used  integer,
  model        text,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX chat_history_session ON chat_history (user_id, session_id, created_at);

-- ── Spending predictions ─────────────────────────────────────
CREATE TABLE spending_predictions (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- NULL category_id = whole-account forecast.
  category_id      uuid REFERENCES categories(id) ON DELETE CASCADE,
  predicted_amount numeric(12,2) NOT NULL,
  lower_bound      numeric(12,2),
  upper_bound      numeric(12,2),
  confidence       numeric(4,3) NOT NULL DEFAULT 0.8,
  period_start     date NOT NULL,
  period_end       date NOT NULL,
  model            text NOT NULL DEFAULT 'holt-linear',
  generated_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT predictions_period_order CHECK (period_end >= period_start),
  CONSTRAINT predictions_confidence_range CHECK (confidence BETWEEN 0 AND 1)
);
CREATE INDEX predictions_user_period ON spending_predictions (user_id, period_start);
CREATE UNIQUE INDEX predictions_unique_window ON spending_predictions
  (user_id, coalesce(category_id, '00000000-0000-0000-0000-000000000000'::uuid), period_start, model);

-- ── Notifications ────────────────────────────────────────────
CREATE TABLE notifications (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  subscription_id  uuid REFERENCES subscriptions(id) ON DELETE CASCADE,
  type             text NOT NULL DEFAULT 'renewal',
  title            text NOT NULL,
  body             text NOT NULL,
  channel          text NOT NULL DEFAULT 'in_app'
                     CHECK (channel IN ('in_app','email','desktop')),
  priority         text NOT NULL DEFAULT 'normal'
                     CHECK (priority IN ('low','normal','high')),
  -- The scheduler picks up rows whose scheduled_for has passed and
  -- sent_at is still null, which makes delivery idempotent and restartable.
  scheduled_for    timestamptz NOT NULL DEFAULT now(),
  sent_at          timestamptz,
  read_at          timestamptz,
  dedupe_key       text,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX notifications_pending ON notifications (scheduled_for)
  WHERE sent_at IS NULL;
CREATE INDEX notifications_user ON notifications (user_id, created_at DESC);
CREATE UNIQUE INDEX notifications_dedupe ON notifications (user_id, dedupe_key)
  WHERE dedupe_key IS NOT NULL;
