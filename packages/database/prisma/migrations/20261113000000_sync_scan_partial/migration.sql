-- A scan may describe the whole repository or one batch of it. Without the distinction a batch's
-- absences read as deletions, so every entry the batch did not carry became an archive candidate.
ALTER TABLE "sync_scans" ADD COLUMN "partial" BOOLEAN NOT NULL DEFAULT false;
