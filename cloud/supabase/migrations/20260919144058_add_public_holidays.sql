BEGIN;
CREATE TABLE IF NOT EXISTS overnight_private.public_holidays (
  holiday_date date PRIMARY KEY,
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 100),
  source text NOT NULL CHECK (length(btrim(source)) BETWEEN 1 AND 100),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

REVOKE ALL ON overnight_private.public_holidays FROM PUBLIC;
DO $$ DECLARE name text; BEGIN
  FOREACH name IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT FROM pg_roles WHERE rolname = name) THEN
      EXECUTE format('REVOKE ALL ON overnight_private.public_holidays FROM %I', name);
    END IF;
  END LOOP;
END $$;
ALTER TABLE overnight_private.public_holidays ENABLE ROW LEVEL SECURITY;
ALTER TABLE overnight_private.public_holidays FORCE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_policies WHERE schemaname = 'overnight_private' AND tablename = 'public_holidays' AND policyname = 'backend_only') THEN
    CREATE POLICY backend_only ON overnight_private.public_holidays TO overnight_app USING (true) WITH CHECK (true);
  END IF;
END $$;
GRANT SELECT, INSERT, UPDATE, DELETE ON overnight_private.public_holidays TO overnight_app;
COMMIT;
