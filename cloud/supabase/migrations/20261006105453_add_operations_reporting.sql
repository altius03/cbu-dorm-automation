BEGIN;
CREATE TABLE IF NOT EXISTS overnight_private.daily_logins (
  activity_date date NOT NULL,
  account_key bytea NOT NULL REFERENCES overnight_private.profiles(account_key) ON DELETE CASCADE,
  PRIMARY KEY (activity_date, account_key)
);
CREATE INDEX IF NOT EXISTS daily_logins_account ON overnight_private.daily_logins(account_key);

-- Only sanitized operational outcomes belong here. No credentials or error messages.
CREATE TABLE IF NOT EXISTS overnight_private.operations_runs (
  kind text NOT NULL CHECK (kind IN ('health', 'holidays', 'report', 'setup')),
  run_key text NOT NULL CHECK (length(run_key) BETWEEN 1 AND 80),
  status text NOT NULL CHECK (status IN ('running', 'success', 'failed', 'unknown')),
  attempts integer NOT NULL DEFAULT 1 CHECK (attempts > 0),
  started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  finished_at timestamptz,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(detail) = 'object'),
  PRIMARY KEY (kind, run_key)
);
CREATE INDEX IF NOT EXISTS operations_runs_recent ON overnight_private.operations_runs(kind, started_at DESC);
CREATE INDEX IF NOT EXISTS batch_reporting_date ON overnight_private.batch_jobs(created_at);

REVOKE ALL ON overnight_private.daily_logins, overnight_private.operations_runs FROM PUBLIC;
DO $$ DECLARE role_name text; table_name text; BEGIN
  FOREACH role_name IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT FROM pg_roles WHERE rolname = role_name) THEN
      EXECUTE format('REVOKE ALL ON overnight_private.daily_logins, overnight_private.operations_runs FROM %I', role_name);
    END IF;
  END LOOP;
  FOREACH table_name IN ARRAY ARRAY['daily_logins', 'operations_runs'] LOOP
    EXECUTE format('ALTER TABLE overnight_private.%I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE overnight_private.%I FORCE ROW LEVEL SECURITY', table_name);
    IF NOT EXISTS (SELECT FROM pg_policies WHERE schemaname = 'overnight_private' AND tablename = table_name AND policyname = 'backend_only') THEN
      EXECUTE format('CREATE POLICY backend_only ON overnight_private.%I TO overnight_app USING (true) WITH CHECK (true)', table_name);
    END IF;
  END LOOP;
END $$;
GRANT SELECT, INSERT, UPDATE, DELETE ON overnight_private.daily_logins, overnight_private.operations_runs TO overnight_app;
COMMIT;
