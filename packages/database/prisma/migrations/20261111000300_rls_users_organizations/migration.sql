-- Row level security for the three tables that had none.
--
-- These are the tables without an `organization_id` column, which is why they were left out:
-- `users` and `organizations` are global by nature, and `review_actions` reaches its tenant
-- through `review_tasks`. The application role is not the table owner, so without a policy the
-- gap ran the wrong way — an unscoped read returned *everything* rather than nothing.

-- A user is visible when they are a member of the organization the session is scoped to.
-- The membership subquery is itself protected by its own policy, so this cannot be used to
-- enumerate another tenant's people: with no organization context the subquery is empty and the
-- predicate is false for every row.
ALTER TABLE "users" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "users";
CREATE POLICY tenant_isolation ON "users"
  USING (
    rls_bypassed()
    OR EXISTS (
      SELECT 1 FROM "memberships" m
      WHERE m.user_id = "users".id AND m.organization_id = current_organization_id()
    )
  )
  WITH CHECK (rls_bypassed() OR EXISTS (
    SELECT 1 FROM "memberships" m
    WHERE m.user_id = "users".id AND m.organization_id = current_organization_id()
  ));

-- An organization row is visible only when it is the one the session is scoped to.
ALTER TABLE "organizations" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "organizations";
CREATE POLICY tenant_isolation ON "organizations"
  USING (id = current_organization_id() OR rls_bypassed())
  WITH CHECK (id = current_organization_id() OR rls_bypassed());

-- Review actions belong to the organization of their review task.
ALTER TABLE "review_actions" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "review_actions";
CREATE POLICY tenant_isolation ON "review_actions"
  USING (
    rls_bypassed()
    OR EXISTS (
      SELECT 1 FROM "review_tasks" t
      WHERE t.id = "review_actions".task_id AND t.organization_id = current_organization_id()
    )
  )
  WITH CHECK (
    rls_bypassed()
    OR EXISTS (
      SELECT 1 FROM "review_tasks" t
      WHERE t.id = "review_actions".task_id AND t.organization_id = current_organization_id()
    )
  );

-- The authentication path reads `users` before any organization is known — login looks a person
-- up by email, and `AuthGuard` loads the actor's memberships. Both already run through
-- `TenantPrisma.withoutTenantScope`, which sets `app.bypass_rls`, so the new policy does not
-- break them; this comment records why that exception is load-bearing rather than incidental.
COMMENT ON POLICY tenant_isolation ON "users" IS
  'Login and token authentication run with app.bypass_rls = on; see docs/DATABASE.md.';
