BEGIN;
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'overnight_private' AND table_name = 'profiles' AND column_name = 'credential_ciphertext'
  ) THEN
    ALTER TABLE overnight_private.profiles ALTER COLUMN credential_ciphertext DROP NOT NULL;
  END IF;
END $$;
COMMIT;
