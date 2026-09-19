BEGIN;
ALTER TABLE overnight_private.profiles DROP COLUMN IF EXISTS credential_ciphertext;
COMMIT;
