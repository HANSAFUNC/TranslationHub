-- Remember the organization a user last opened.
--
-- Login used to pick `memberships[0]`, which is whatever order the database returned. That was
-- survivable while an account belonged to exactly one organization; now that an admin can attach
-- an existing account to a second one, it means a person in two tenants lands in a random one.
ALTER TABLE "users" ADD COLUMN "last_organization_id" UUID;
