BEGIN;
CREATE TABLE IF NOT EXISTS overnight_private.residency_schedules (
  term text PRIMARY KEY CHECK (term ~ '^\d{4}-[12]$'),
  starts_on date NOT NULL,
  through_on date NOT NULL,
  semester_end date NOT NULL,
  six_month_end date NOT NULL,
  twelve_month_end date NOT NULL,
  source text NOT NULL CHECK (length(btrim(source)) BETWEEN 1 AND 200),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (starts_on <= through_on),
  CHECK (starts_on <= semester_end AND semester_end <= six_month_end AND six_month_end <= twelve_month_end)
);

INSERT INTO overnight_private.residency_schedules
  (term, starts_on, through_on, semester_end, six_month_end, twelve_month_end, source, updated_at)
VALUES
  ('2026-1', '2026-02-27', '2026-08-28', '2026-06-23', '2026-08-15', '2027-02-13', '2026학년도 생활관 모집 공지', '2026-09-19T00:00:00Z'),
  ('2026-2', '2026-08-29', '2027-02-13', '2026-12-23', '2027-02-13', '2027-02-13', '2026학년도 생활관 모집 공지', '2026-09-19T00:00:00Z')
ON CONFLICT (term) DO NOTHING;

REVOKE ALL ON overnight_private.residency_schedules FROM PUBLIC;
DO $$ DECLARE name text; BEGIN
  FOREACH name IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT FROM pg_roles WHERE rolname = name) THEN
      EXECUTE format('REVOKE ALL ON overnight_private.residency_schedules FROM %I', name);
    END IF;
  END LOOP;
END $$;
ALTER TABLE overnight_private.residency_schedules ENABLE ROW LEVEL SECURITY;
ALTER TABLE overnight_private.residency_schedules FORCE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_policies WHERE schemaname = 'overnight_private' AND tablename = 'residency_schedules' AND policyname = 'backend_only') THEN
    CREATE POLICY backend_only ON overnight_private.residency_schedules TO overnight_app USING (true) WITH CHECK (true);
  END IF;
END $$;
GRANT SELECT, INSERT, UPDATE ON overnight_private.residency_schedules TO overnight_app;
COMMIT;
