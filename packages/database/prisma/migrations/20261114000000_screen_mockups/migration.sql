-- Screen mockups: a sketch of a screen plus the position of each key's text on it.
--
-- Why this is a table and not a field on `translation_keys`: a key can appear on several screens, and
-- the same screen is re-uploaded as the UI changes. The sketch is its own artifact with its own
-- lifecycle, and the markers are its rows.
--
-- The image bytes live in the row (`image BYTEA`). A release bundle can be tens of megabytes and is
-- written to a directory, but a wireframe or screenshot is a few hundred kilobytes, and keeping it
-- here means one storage system, one RLS policy, and no volume to mount.
CREATE TABLE "screen_mockups" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "platform" "PlatformKind" NOT NULL DEFAULT 'web',
    "locale" TEXT NOT NULL,
    "width" INTEGER,
    "height" INTEGER,
    "mime_type" TEXT NOT NULL,
    "byte_size" INTEGER NOT NULL,
    "content_hash" TEXT NOT NULL,
    "image" BYTEA NOT NULL,
    "created_by_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "screen_mockups_pkey" PRIMARY KEY ("id")
);

-- The name is the identity within a screen: an agent that regenerates the sketch re-uploads it under
-- the same name and replaces the old one, instead of accumulating `checkout-2`, `checkout-final`.
CREATE UNIQUE INDEX "screen_mockups_project_id_platform_name_key" ON "screen_mockups"("project_id", "platform", "name");
CREATE INDEX "screen_mockups_organization_id_idx" ON "screen_mockups"("organization_id");

-- Markers. `key` + `namespace` are text, deliberately not a foreign key: a sketch is frequently
-- uploaded before the keys it points at exist, and a marker for a key the platform has not imported
-- is a fact about the UI rather than an error to reject.
--
-- Coordinates are fractions of the image (0..1), so a marker stays put when the sketch is rendered at
-- any size or re-exported at a different resolution.
CREATE TABLE "screen_mockup_markers" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "mockup_id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "namespace" TEXT NOT NULL DEFAULT '',
    "x" DOUBLE PRECISION NOT NULL,
    "y" DOUBLE PRECISION NOT NULL,
    "width" DOUBLE PRECISION,
    "height" DOUBLE PRECISION,
    "text" TEXT,
    "note" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "screen_mockup_markers_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "screen_mockup_markers_organization_id_idx" ON "screen_mockup_markers"("organization_id");
CREATE INDEX "screen_mockup_markers_mockup_id_idx" ON "screen_mockup_markers"("mockup_id");
-- "which screens show this key" — the query the editor runs when it opens an entry.
CREATE INDEX "screen_mockup_markers_organization_id_key_idx" ON "screen_mockup_markers"("organization_id", "key");

ALTER TABLE "screen_mockups" ADD CONSTRAINT "screen_mockups_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "screen_mockup_markers" ADD CONSTRAINT "screen_mockup_markers_mockup_id_fkey" FOREIGN KEY ("mockup_id") REFERENCES "screen_mockups"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Row level security, matching every other tenant table: the application role is not the table owner,
-- so a missing organization context yields zero rows rather than everything.
ALTER TABLE "screen_mockups" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "screen_mockups"
  USING (organization_id = current_organization_id() OR rls_bypassed())
  WITH CHECK (organization_id = current_organization_id() OR rls_bypassed());

ALTER TABLE "screen_mockup_markers" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "screen_mockup_markers"
  USING (organization_id = current_organization_id() OR rls_bypassed())
  WITH CHECK (organization_id = current_organization_id() OR rls_bypassed());
