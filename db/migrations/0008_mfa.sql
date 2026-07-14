-- 0008: TOTP two-factor authentication columns (05-security.md §1).
ALTER TABLE users
  ADD COLUMN totp_secret text,
  ADD COLUMN totp_enabled boolean NOT NULL DEFAULT false;

GRANT UPDATE (totp_secret, totp_enabled) ON users TO jenga_app;
