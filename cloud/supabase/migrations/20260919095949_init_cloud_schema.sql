-- Run once as a migration administrator. Never expose this schema in the Data API.
-- Assign a login password for overnight_app outside this file through secret management.
BEGIN;
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'overnight_app') THEN
    CREATE ROLE overnight_app LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;
  END IF;
  -- Supabase's migration administrator is not a PostgreSQL superuser. Even setting
  -- special attributes to false requires superuser, and NOCREATEDB needs CREATEDB.
  -- Inspect existing privilege flags and refuse unsafe roles instead of altering them.
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'overnight_app' AND (rolsuper OR rolreplication OR rolbypassrls OR rolcreatedb OR rolcreaterole)) THEN
    RAISE EXCEPTION 'The existing overnight_app role has elevated privileges; use a dedicated unprivileged role.';
  END IF;
END $$;
ALTER ROLE overnight_app LOGIN NOINHERIT;
ALTER ROLE overnight_app SET statement_timeout = '10s';
ALTER ROLE overnight_app SET lock_timeout = '5s';
ALTER ROLE overnight_app SET idle_in_transaction_session_timeout = '15s';
CREATE SCHEMA IF NOT EXISTS overnight_private;
REVOKE ALL ON SCHEMA overnight_private FROM PUBLIC;

CREATE TABLE IF NOT EXISTS overnight_private.key_guard (
  id integer PRIMARY KEY CHECK (id = 1),
  fingerprint bytea NOT NULL CHECK (octet_length(fingerprint) = 32)
);

CREATE TABLE IF NOT EXISTS overnight_private.profiles (
  id uuid PRIMARY KEY,
  account_key bytea NOT NULL UNIQUE CHECK (octet_length(account_key) = 32),
  token_hash bytea NOT NULL UNIQUE CHECK (octet_length(token_hash) = 32),
  credential_ciphertext text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE IF NOT EXISTS overnight_private.used_setup_tokens (
  token_hash bytea PRIMARY KEY,
  used_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE IF NOT EXISTS overnight_private.batch_jobs (
  id uuid PRIMARY KEY,
  profile_id uuid NOT NULL REFERENCES overnight_private.profiles(id) ON DELETE CASCADE,
  status text NOT NULL CHECK (status IN ('running', 'done', 'failed', 'interrupted')),
  result jsonb NOT NULL CHECK (jsonb_typeof(result->'results') IS NOT DISTINCT FROM 'array'),
  cancel_requested boolean NOT NULL DEFAULT false,
  claim_index integer,
  attempt uuid,
  lease_until timestamptz,
  dispatch_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK ((claim_index IS NULL AND attempt IS NULL AND lease_until IS NULL) OR
         (claim_index IS NOT NULL AND claim_index >= 0 AND attempt IS NOT NULL AND lease_until IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS one_active_batch ON overnight_private.batch_jobs(profile_id) WHERE status = 'running';
CREATE INDEX IF NOT EXISTS batch_history ON overnight_private.batch_jobs(profile_id, updated_at DESC, created_at DESC);
CREATE TABLE IF NOT EXISTS overnight_private.rate_limits (
  key_hash bytea PRIMARY KEY,
  count integer NOT NULL,
  expires_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS rate_expiry ON overnight_private.rate_limits(expires_at);
CREATE TABLE IF NOT EXISTS overnight_private.busy_locks (
  key_hash bytea PRIMARY KEY,
  owner uuid NOT NULL,
  expires_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS busy_expiry ON overnight_private.busy_locks(expires_at);

REVOKE ALL ON ALL TABLES IN SCHEMA overnight_private FROM PUBLIC;
DO $$ DECLARE name text; BEGIN
  FOREACH name IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT FROM pg_roles WHERE rolname = name) THEN
      EXECUTE format('REVOKE ALL ON SCHEMA overnight_private FROM %I', name);
      EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA overnight_private FROM %I', name);
    END IF;
  END LOOP;
  FOREACH name IN ARRAY ARRAY['key_guard', 'profiles', 'used_setup_tokens', 'batch_jobs', 'rate_limits', 'busy_locks'] LOOP
    EXECUTE format('ALTER TABLE overnight_private.%I ENABLE ROW LEVEL SECURITY', name);
    EXECUTE format('ALTER TABLE overnight_private.%I FORCE ROW LEVEL SECURITY', name);
    IF NOT EXISTS (SELECT FROM pg_policies WHERE schemaname = 'overnight_private' AND tablename = name AND policyname = 'backend_only') THEN
      EXECUTE format('CREATE POLICY backend_only ON overnight_private.%I TO overnight_app USING (true) WITH CHECK (true)', name);
    END IF;
  END LOOP;
END $$;
GRANT USAGE ON SCHEMA overnight_private TO overnight_app;
REVOKE ALL ON ALL TABLES IN SCHEMA overnight_private FROM overnight_app;
GRANT SELECT, INSERT ON overnight_private.key_guard, overnight_private.used_setup_tokens TO overnight_app;
GRANT SELECT, INSERT, UPDATE ON overnight_private.batch_jobs TO overnight_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON overnight_private.profiles, overnight_private.rate_limits, overnight_private.busy_locks TO overnight_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA overnight_private REVOKE ALL ON TABLES FROM PUBLIC;
COMMIT;
