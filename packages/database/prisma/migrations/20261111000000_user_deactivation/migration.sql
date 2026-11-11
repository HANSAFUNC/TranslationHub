-- Account suspension.
--
-- Nullable and defaulted to NULL, so existing rows keep working and the column can be added
-- without a rewrite of the users table.
ALTER TABLE "users" ADD COLUMN "deactivated_at" TIMESTAMP(3);
