-- Webhook endpoints and their delivery record.
--
-- The signing secret is stored encrypted (AES-256-GCM, key derived from ENCRYPTION_KEY), not
-- hashed: verifying a token needs only its hash, but producing an HMAC signature needs the key.
-- Encryption keeps it out of reach of a database dump while still letting the worker sign.
CREATE TABLE "webhooks" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "url" TEXT NOT NULL,
    "event_types" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "secret_encrypted" TEXT NOT NULL,
    "secret_prefix" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "description" TEXT,
    "created_by_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "webhooks_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "webhook_deliveries" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "webhook_id" UUID NOT NULL,
    "event_id" TEXT NOT NULL,
    "event_type" TEXT NOT NULL,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "last_status_code" INTEGER,
    "last_error" TEXT,
    "next_attempt_at" TIMESTAMP(3),
    "delivered_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "webhook_deliveries_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "webhooks_organization_id_active_idx" ON "webhooks"("organization_id", "active");
-- One row per event per endpoint: a retry updates the row rather than inserting a second one, so a
-- delivery cannot be duplicated by a worker restart.
CREATE UNIQUE INDEX "webhook_deliveries_webhook_id_event_id_key" ON "webhook_deliveries"("webhook_id", "event_id");
CREATE INDEX "webhook_deliveries_status_next_attempt_at_idx" ON "webhook_deliveries"("status", "next_attempt_at");

ALTER TABLE "webhooks" ADD CONSTRAINT "webhooks_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_webhook_id_fkey" FOREIGN KEY ("webhook_id") REFERENCES "webhooks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Row level security, matching every other tenant table: the application role is not the table
-- owner, so a missing organization context yields zero rows rather than everything.
ALTER TABLE "webhooks" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "webhooks"
  USING (organization_id = current_organization_id() OR rls_bypassed())
  WITH CHECK (organization_id = current_organization_id() OR rls_bypassed());

ALTER TABLE "webhook_deliveries" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "webhook_deliveries"
  USING (organization_id = current_organization_id() OR rls_bypassed())
  WITH CHECK (organization_id = current_organization_id() OR rls_bypassed());
