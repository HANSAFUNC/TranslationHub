-- Organization-level switch for `include_drafts` on pull/apply.
--
-- The delivery spec allows an explicit `include_drafts=true` path, but it lets unapproved draft
-- text overwrite approved copy in a repository. Defaulting to false means an instance has to opt
-- in deliberately instead of relying on every caller to leave the flag alone.

ALTER TABLE "organizations" ADD COLUMN "allow_draft_apply" BOOLEAN NOT NULL DEFAULT false;
