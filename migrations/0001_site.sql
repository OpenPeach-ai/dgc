-- DGC website form, subscription, and abuse-control state.
-- Apply to the production D1 database before deploying _worker.js. Preview
-- deployments intentionally run without the production data binding.

CREATE TABLE rate_limits (
  bucket_key TEXT PRIMARY KEY CHECK (length(bucket_key) = 64),
  kind TEXT NOT NULL,
  window_id INTEGER NOT NULL,
  count INTEGER NOT NULL CHECK (count >= 1),
  expires_at INTEGER NOT NULL
) STRICT, WITHOUT ROWID;

CREATE INDEX rate_limits_expiry ON rate_limits (expires_at);

CREATE TABLE form_cooldowns (
  cooldown_key TEXT PRIMARY KEY CHECK (length(cooldown_key) = 64),
  kind TEXT NOT NULL,
  lease_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL
) STRICT, WITHOUT ROWID;

CREATE INDEX form_cooldowns_expiry ON form_cooldowns (expires_at);

CREATE TABLE pending_subscriptions (
  email_hash TEXT PRIMARY KEY CHECK (length(email_hash) = 64),
  email TEXT NOT NULL CHECK (length(email) <= 254),
  token_hash TEXT NOT NULL UNIQUE CHECK (length(token_hash) = 64),
  token TEXT NOT NULL CHECK (length(token) BETWEEN 40 AND 64),
  unsubscribe_token_hash TEXT NOT NULL UNIQUE CHECK (length(unsubscribe_token_hash) = 64),
  unsubscribe_token TEXT NOT NULL CHECK (length(unsubscribe_token) BETWEEN 40 AND 64),
  source TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  delivery_state TEXT NOT NULL
    CHECK (delivery_state IN ('pending', 'accepted', 'unknown')),
  resend_id TEXT,
  idempotency_key TEXT NOT NULL UNIQUE,
  CHECK (expires_at > created_at)
) STRICT, WITHOUT ROWID;

CREATE INDEX pending_subscriptions_expiry
  ON pending_subscriptions (expires_at);

CREATE TABLE subscribers (
  email_hash TEXT PRIMARY KEY CHECK (length(email_hash) = 64),
  email TEXT NOT NULL CHECK (length(email) <= 254),
  confirmation_token_hash TEXT NOT NULL UNIQUE CHECK (length(confirmation_token_hash) = 64),
  unsubscribe_token TEXT NOT NULL CHECK (length(unsubscribe_token) BETWEEN 40 AND 64),
  unsubscribe_token_hash TEXT NOT NULL UNIQUE CHECK (length(unsubscribe_token_hash) = 64),
  confirmed_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT, WITHOUT ROWID;

CREATE TABLE commercial_leads (
  id TEXT PRIMARY KEY,
  email_hash TEXT NOT NULL CHECK (length(email_hash) = 64),
  submission_hash TEXT NOT NULL CHECK (length(submission_hash) = 64),
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
  email TEXT NOT NULL CHECK (length(email) <= 254),
  company TEXT NOT NULL CHECK (length(company) BETWEEN 1 AND 160),
  seats TEXT NOT NULL CHECK (seats IN ('1–10', '11–50', '51–200', '201+')),
  use_case TEXT NOT NULL CHECK (length(use_case) BETWEEN 10 AND 2000),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  delivery_state TEXT NOT NULL
    CHECK (delivery_state IN ('sending', 'accepted', 'unknown')),
  resend_id TEXT,
  idempotency_key TEXT NOT NULL UNIQUE,
  CHECK (expires_at > created_at)
) STRICT, WITHOUT ROWID;

CREATE INDEX commercial_leads_expiry ON commercial_leads (expires_at);
CREATE INDEX commercial_leads_retry
  ON commercial_leads (email_hash, submission_hash, delivery_state, created_at);
