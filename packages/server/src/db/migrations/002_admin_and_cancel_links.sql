-- ============================================================
-- Admin panel support + one-click subscription cancellation links
-- ============================================================

ALTER TABLE users ADD COLUMN is_admin boolean NOT NULL DEFAULT false;

-- Cancellation links reuse the single-use, hashed token pattern already
-- used for e-mail verification and password reset, plus a subscription_id
-- so the token is scoped to exactly one action rather than the whole
-- account. Critically, the GET route that resolves this token never
-- consumes it: mail clients and link-safety scanners (Outlook Safe Links,
-- Gmail's image/link proxy) fetch URLs automatically before a human ever
-- sees them, so only an explicit POST — triggered by a button click on the
-- confirmation page — performs the cancellation.
ALTER TABLE auth_tokens ADD COLUMN subscription_id uuid REFERENCES subscriptions(id) ON DELETE CASCADE;
ALTER TABLE auth_tokens DROP CONSTRAINT auth_tokens_kind_check;
ALTER TABLE auth_tokens ADD CONSTRAINT auth_tokens_kind_check
  CHECK (kind IN ('verify_email', 'reset_password', 'cancel_subscription'));

-- Every admin action is recorded: who did it, what they did, and to whom.
-- ON DELETE SET NULL for target_user_id (not CASCADE) so deleting the
-- affected user does not erase the record that an admin deleted them.
CREATE TABLE admin_audit_log (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_user_id   uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  action          text NOT NULL,
  target_user_id  uuid REFERENCES users(id) ON DELETE SET NULL,
  detail          jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX admin_audit_log_recent ON admin_audit_log (created_at DESC);
CREATE INDEX admin_audit_log_admin ON admin_audit_log (admin_user_id, created_at DESC);
