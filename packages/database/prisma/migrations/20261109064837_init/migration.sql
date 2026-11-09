-- CreateEnum
CREATE TYPE "OrgRole" AS ENUM ('ORG_OWNER', 'ORG_ADMIN', 'PROJECT_MANAGER', 'DEVELOPER', 'PRODUCT_MANAGER', 'TRANSLATOR', 'REVIEWER', 'READONLY');

-- CreateEnum
CREATE TYPE "ProjectRole" AS ENUM ('PROJECT_MANAGER', 'DEVELOPER', 'PRODUCT_MANAGER', 'TRANSLATOR', 'REVIEWER', 'READONLY');

-- CreateEnum
CREATE TYPE "PlatformKind" AS ENUM ('web', 'ios', 'android', 'universal');

-- CreateEnum
CREATE TYPE "ReviewStatus" AS ENUM ('DRAFT', 'PENDING_REVIEW', 'APPROVED', 'REJECTED', 'STALE');

-- CreateEnum
CREATE TYPE "LocaleStatus" AS ENUM ('ACTIVE', 'INACTIVE');

-- CreateEnum
CREATE TYPE "RepoProvider" AS ENUM ('github', 'gitlab', 'bitbucket', 'azure_devops', 'local');

-- CreateEnum
CREATE TYPE "RepositoryStatus" AS ENUM ('ACTIVE', 'DISABLED');

-- CreateEnum
CREATE TYPE "SyncDirection" AS ENUM ('push', 'pull', 'bidirectional');

-- CreateEnum
CREATE TYPE "SyncSessionStatus" AS ENUM ('PENDING', 'RUNNING', 'PARTIAL', 'SUCCEEDED', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "SyncItemAction" AS ENUM ('SKIP', 'PUSH_LOCAL', 'PUSH_NEW', 'PULL_REMOTE', 'PULL_NEW', 'CONVERGED', 'CONFLICT', 'ARCHIVE_CANDIDATE', 'REMOTE_ARCHIVE_CANDIDATE', 'ARCHIVE_CONVERGED');

-- CreateEnum
CREATE TYPE "SyncItemStatus" AS ENUM ('PENDING', 'APPLIED', 'SKIPPED', 'FAILED', 'CONFLICT');

-- CreateEnum
CREATE TYPE "ConflictStatus" AS ENUM ('OPEN', 'RESOLVED', 'DEFERRED');

-- CreateEnum
CREATE TYPE "ConflictResolution" AS ENUM ('KEEP_LOCAL', 'KEEP_REMOTE', 'MANUAL_MERGE', 'DEFER');

-- CreateEnum
CREATE TYPE "ConflictReason" AS ENUM ('LOCAL_AND_REMOTE_CHANGED', 'SOURCE_VERSION_CHANGED', 'FILE_MAPPING_CHANGED', 'LOCAL_DELETED_REMOTE_CHANGED');

-- CreateEnum
CREATE TYPE "ProjectEventType" AS ENUM ('KEY_CREATED', 'KEY_ARCHIVED', 'SOURCE_VERSION_CREATED', 'TRANSLATION_CREATED', 'TRANSLATION_UPDATED', 'TRANSLATION_SUBMITTED', 'TRANSLATION_APPROVED', 'TRANSLATION_REJECTED', 'TRANSLATION_STALE', 'SYNC_PUSHED', 'SYNC_APPLIED', 'CONFLICT_RESOLVED', 'RELEASE_PUBLISHED');

-- CreateEnum
CREATE TYPE "ReviewDecision" AS ENUM ('APPROVE', 'REJECT', 'REQUEST_CHANGES');

-- CreateEnum
CREATE TYPE "QaSeverity" AS ENUM ('ERROR', 'WARNING', 'INFO');

-- CreateEnum
CREATE TYPE "QaRunStatus" AS ENUM ('PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED');

-- CreateEnum
CREATE TYPE "QaIssueStatus" AS ENUM ('OPEN', 'RESOLVED', 'IGNORED');

-- CreateEnum
CREATE TYPE "ReleaseStatus" AS ENUM ('DRAFT', 'VALIDATED', 'PUBLISHED');

-- CreateEnum
CREATE TYPE "McpTokenKind" AS ENUM ('MCP', 'API');

-- CreateEnum
CREATE TYPE "SkillKind" AS ENUM ('PROMPT', 'SCRIPT');

-- CreateEnum
CREATE TYPE "SkillStatus" AS ENUM ('DRAFT', 'PUBLISHED', 'DISABLED');

-- CreateEnum
CREATE TYPE "AiProviderKind" AS ENUM ('anthropic', 'openai', 'azure_openai', 'ollama', 'custom');

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "is_platform_admin" BOOLEAN NOT NULL DEFAULT false,
    "last_login_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "organizations" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "organizations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "memberships" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "role" "OrgRole" NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "memberships_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "projects" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "description" TEXT,
    "source_locale" TEXT NOT NULL,
    "default_platform" "PlatformKind" NOT NULL DEFAULT 'web',
    "revision" INTEGER NOT NULL DEFAULT 0,
    "ai_policy" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "projects_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "project_members" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "role" "ProjectRole" NOT NULL,
    "locale_scope" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "project_members_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "locales" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "is_source" BOOLEAN NOT NULL DEFAULT false,
    "status" "LocaleStatus" NOT NULL DEFAULT 'ACTIVE',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "locales_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "project_platforms" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "platform" "PlatformKind" NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "project_platforms_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "namespaces" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "name" TEXT NOT NULL DEFAULT '',
    "platform" "PlatformKind" NOT NULL DEFAULT 'universal',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "namespaces_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "translation_keys" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "platform" "PlatformKind" NOT NULL DEFAULT 'web',
    "namespace_id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "description" TEXT,
    "context" JSONB,
    "archived_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "translation_keys_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "source_versions" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "key_id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "value" TEXT NOT NULL,
    "content_hash" TEXT NOT NULL,
    "description" TEXT,
    "author_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "source_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "translation_entries" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "key_id" UUID NOT NULL,
    "locale_id" UUID NOT NULL,
    "locale_code" TEXT NOT NULL,
    "value" TEXT NOT NULL DEFAULT '',
    "content_hash" TEXT NOT NULL,
    "status" "ReviewStatus" NOT NULL DEFAULT 'DRAFT',
    "revision" INTEGER NOT NULL DEFAULT 1,
    "current_version_id" UUID,
    "based_on_source_version_id" UUID,
    "comment" TEXT,
    "updated_by_id" UUID,
    "applied_to_repo_at" TIMESTAMP(3),
    "applied_to_repo_commit" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "translation_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "translation_versions" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "entry_id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "value" TEXT NOT NULL,
    "content_hash" TEXT NOT NULL,
    "status" "ReviewStatus" NOT NULL DEFAULT 'DRAFT',
    "author_id" UUID,
    "author_type" TEXT NOT NULL DEFAULT 'user',
    "based_on_source_version_id" UUID,
    "comment" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "translation_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "review_tasks" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "entry_id" UUID NOT NULL,
    "locale_code" TEXT NOT NULL,
    "status" "ReviewStatus" NOT NULL DEFAULT 'PENDING_REVIEW',
    "assignee_id" UUID,
    "submitted_by_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMP(3),

    CONSTRAINT "review_tasks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "review_actions" (
    "id" UUID NOT NULL,
    "task_id" UUID NOT NULL,
    "actor_id" UUID,
    "decision" "ReviewDecision" NOT NULL,
    "comment" TEXT,
    "entry_version" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "review_actions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "glossary_terms" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "project_id" UUID,
    "term" TEXT NOT NULL,
    "translations" JSONB NOT NULL,
    "description" TEXT,
    "case_sensitive" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "glossary_terms_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "translation_memory_entries" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "project_id" UUID,
    "source_locale" TEXT NOT NULL,
    "target_locale" TEXT NOT NULL,
    "source_hash" TEXT NOT NULL,
    "source_text" TEXT NOT NULL,
    "target_text" TEXT NOT NULL,
    "usage_count" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "translation_memory_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "repository_connections" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "provider" "RepoProvider" NOT NULL DEFAULT 'local',
    "repo_url" TEXT,
    "default_branch" TEXT NOT NULL DEFAULT 'main',
    "status" "RepositoryStatus" NOT NULL DEFAULT 'ACTIVE',
    "last_commit" TEXT,
    "last_branch" TEXT,
    "last_seen_at" TIMESTAMP(3),
    "client_name" TEXT,
    "client_version" TEXT,
    "created_by_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "repository_connections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "repository_file_mappings" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "connection_id" UUID NOT NULL,
    "file_set_id" TEXT NOT NULL,
    "platform" "PlatformKind" NOT NULL,
    "locale" TEXT,
    "locale_from_path" BOOLEAN NOT NULL DEFAULT false,
    "format" TEXT NOT NULL,
    "source" BOOLEAN NOT NULL DEFAULT false,
    "paths" TEXT[],
    "key_mode" TEXT NOT NULL DEFAULT 'nested',
    "namespace_from_path" BOOLEAN NOT NULL DEFAULT false,
    "preserve_platform_metadata" BOOLEAN NOT NULL DEFAULT true,
    "last_scanned_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "repository_file_mappings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sync_scans" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "connection_id" UUID,
    "scan_id" TEXT NOT NULL,
    "client_name" TEXT,
    "client_version" TEXT,
    "git_branch" TEXT,
    "git_commit" TEXT,
    "file_count" INTEGER NOT NULL DEFAULT 0,
    "entry_count" INTEGER NOT NULL DEFAULT 0,
    "files" JSONB NOT NULL DEFAULT '[]',
    "entries" JSONB NOT NULL DEFAULT '[]',
    "warnings" JSONB NOT NULL DEFAULT '[]',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sync_scans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sync_sessions" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "connection_id" UUID,
    "direction" "SyncDirection" NOT NULL,
    "status" "SyncSessionStatus" NOT NULL DEFAULT 'PENDING',
    "base_revision" INTEGER,
    "revision_after" INTEGER,
    "plan_hash" TEXT,
    "summary" JSONB,
    "error" TEXT,
    "client_name" TEXT,
    "client_version" TEXT,
    "git_branch" TEXT,
    "git_commit" TEXT,
    "created_by_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMP(3),

    CONSTRAINT "sync_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sync_items" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "session_id" UUID NOT NULL,
    "action" "SyncItemAction" NOT NULL,
    "status" "SyncItemStatus" NOT NULL DEFAULT 'PENDING',
    "translation_key" TEXT NOT NULL,
    "locale_code" TEXT NOT NULL,
    "platform" "PlatformKind" NOT NULL,
    "namespace" TEXT NOT NULL DEFAULT '',
    "local_hash" TEXT,
    "remote_hash" TEXT,
    "base_hash" TEXT,
    "entry_id" UUID,
    "translation_version_id" UUID,
    "error_code" TEXT,
    "error_message" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sync_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sync_baselines" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "connection_id" UUID NOT NULL,
    "platform" "PlatformKind" NOT NULL,
    "namespace" TEXT NOT NULL DEFAULT '',
    "translation_key" TEXT NOT NULL,
    "locale_code" TEXT NOT NULL,
    "local_hash" TEXT,
    "remote_hash" TEXT,
    "base_value" TEXT,
    "source_version_id" UUID,
    "translation_version_id" UUID,
    "remote_revision" INTEGER NOT NULL DEFAULT 0,
    "last_synced_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sync_baselines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sync_plans" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "session_id" UUID NOT NULL,
    "scan_id" TEXT NOT NULL,
    "direction" "SyncDirection" NOT NULL,
    "base_revision" INTEGER NOT NULL,
    "plan_hash" TEXT NOT NULL,
    "plan_json" JSONB NOT NULL,
    "summary" JSONB NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "confirmed_at" TIMESTAMP(3),
    "idempotency_key" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sync_plans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sync_conflicts" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "session_id" UUID,
    "platform" "PlatformKind" NOT NULL,
    "namespace" TEXT NOT NULL DEFAULT '',
    "translation_key" TEXT NOT NULL,
    "locale_code" TEXT NOT NULL,
    "base_value" TEXT,
    "local_value" TEXT,
    "remote_value" TEXT,
    "base_hash" TEXT,
    "local_hash" TEXT,
    "remote_hash" TEXT,
    "reason" "ConflictReason" NOT NULL,
    "file_path" TEXT,
    "remote_version_id" UUID,
    "status" "ConflictStatus" NOT NULL DEFAULT 'OPEN',
    "resolution" "ConflictResolution",
    "resolved_value" TEXT,
    "resolved_by_id" UUID,
    "resolved_at" TIMESTAMP(3),
    "note" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sync_conflicts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sync_apply_reports" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "session_id" UUID NOT NULL,
    "apply_plan_id" TEXT NOT NULL,
    "status" "SyncSessionStatus" NOT NULL,
    "files" JSONB NOT NULL DEFAULT '[]',
    "items" JSONB NOT NULL DEFAULT '[]',
    "applied_count" INTEGER NOT NULL DEFAULT 0,
    "failed_count" INTEGER NOT NULL DEFAULT 0,
    "git_commit" TEXT,
    "git_diff_stat" TEXT,
    "client_name" TEXT,
    "client_version" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sync_apply_reports_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "project_events" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "event_type" "ProjectEventType" NOT NULL,
    "resource_type" TEXT NOT NULL,
    "resource_id" TEXT,
    "revision" INTEGER NOT NULL,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "actor_id" UUID,
    "actor_type" TEXT NOT NULL DEFAULT 'user',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "project_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mcp_clients" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "kind" "McpTokenKind" NOT NULL DEFAULT 'MCP',
    "name" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "token_prefix" TEXT NOT NULL,
    "scopes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "project_ids" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "repository_connection_id" UUID,
    "expires_at" TIMESTAMP(3),
    "last_used_at" TIMESTAMP(3),
    "revoked_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mcp_clients_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "actor_id" UUID,
    "actor_type" TEXT NOT NULL DEFAULT 'user',
    "action" TEXT NOT NULL,
    "resource_type" TEXT NOT NULL,
    "resource_id" TEXT,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "request_id" TEXT,
    "project_id" UUID,
    "repository_connection_id" UUID,
    "sync_session_id" UUID,
    "mcp_client_id" UUID,
    "duration_ms" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "qa_rules" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "project_id" UUID,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "severity" "QaSeverity" NOT NULL DEFAULT 'WARNING',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "config" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "qa_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "qa_runs" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "status" "QaRunStatus" NOT NULL DEFAULT 'PENDING',
    "triggered_by_id" UUID,
    "scope" JSONB NOT NULL DEFAULT '{}',
    "issue_count" INTEGER NOT NULL DEFAULT 0,
    "started_at" TIMESTAMP(3),
    "finished_at" TIMESTAMP(3),
    "error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "qa_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "qa_issues" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "run_id" UUID,
    "entry_id" UUID,
    "translation_key" TEXT NOT NULL,
    "locale_code" TEXT NOT NULL,
    "rule_code" TEXT NOT NULL,
    "severity" "QaSeverity" NOT NULL,
    "message" TEXT NOT NULL,
    "details" JSONB NOT NULL DEFAULT '{}',
    "status" "QaIssueStatus" NOT NULL DEFAULT 'OPEN',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "qa_issues_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_provider_configs" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "kind" "AiProviderKind" NOT NULL,
    "base_url" TEXT,
    "model" TEXT NOT NULL,
    "api_key_encrypted" TEXT,
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_provider_configs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "skills" (
    "id" UUID NOT NULL,
    "organization_id" UUID,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" "SkillKind" NOT NULL DEFAULT 'PROMPT',
    "description" TEXT,
    "version" TEXT NOT NULL DEFAULT '1.0.0',
    "content" TEXT NOT NULL,
    "manifest" JSONB NOT NULL DEFAULT '{}',
    "status" "SkillStatus" NOT NULL DEFAULT 'PUBLISHED',
    "created_by_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "skills_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "releases" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "status" "ReleaseStatus" NOT NULL DEFAULT 'DRAFT',
    "locales" TEXT[],
    "key_count" INTEGER NOT NULL DEFAULT 0,
    "snapshot_checksum" TEXT,
    "created_by_id" UUID,
    "published_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "releases_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "release_snapshots" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "release_id" UUID NOT NULL,
    "translation_key" TEXT NOT NULL,
    "locale_code" TEXT NOT NULL,
    "platform" "PlatformKind" NOT NULL,
    "namespace" TEXT NOT NULL DEFAULT '',
    "value" TEXT NOT NULL,
    "source_version_id" UUID,
    "translation_version_id" UUID,
    "content_hash" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "release_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "organizations_slug_key" ON "organizations"("slug");

-- CreateIndex
CREATE INDEX "memberships_user_id_idx" ON "memberships"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "memberships_organization_id_user_id_key" ON "memberships"("organization_id", "user_id");

-- CreateIndex
CREATE INDEX "projects_organization_id_idx" ON "projects"("organization_id");

-- CreateIndex
CREATE UNIQUE INDEX "projects_organization_id_slug_key" ON "projects"("organization_id", "slug");

-- CreateIndex
CREATE UNIQUE INDEX "project_members_project_id_user_id_key" ON "project_members"("project_id", "user_id");

-- CreateIndex
CREATE INDEX "locales_organization_id_idx" ON "locales"("organization_id");

-- CreateIndex
CREATE UNIQUE INDEX "locales_project_id_code_key" ON "locales"("project_id", "code");

-- CreateIndex
CREATE UNIQUE INDEX "project_platforms_project_id_platform_key" ON "project_platforms"("project_id", "platform");

-- CreateIndex
CREATE UNIQUE INDEX "namespaces_project_id_platform_name_key" ON "namespaces"("project_id", "platform", "name");

-- CreateIndex
CREATE INDEX "translation_keys_organization_id_idx" ON "translation_keys"("organization_id");

-- CreateIndex
CREATE INDEX "translation_keys_project_id_key_idx" ON "translation_keys"("project_id", "key");

-- CreateIndex
CREATE UNIQUE INDEX "translation_keys_project_id_platform_namespace_id_key_key" ON "translation_keys"("project_id", "platform", "namespace_id", "key");

-- CreateIndex
CREATE INDEX "source_versions_project_id_content_hash_idx" ON "source_versions"("project_id", "content_hash");

-- CreateIndex
CREATE UNIQUE INDEX "source_versions_key_id_version_key" ON "source_versions"("key_id", "version");

-- CreateIndex
CREATE INDEX "translation_entries_project_id_status_idx" ON "translation_entries"("project_id", "status");

-- CreateIndex
CREATE INDEX "translation_entries_organization_id_idx" ON "translation_entries"("organization_id");

-- CreateIndex
CREATE INDEX "translation_entries_project_id_locale_code_idx" ON "translation_entries"("project_id", "locale_code");

-- CreateIndex
CREATE UNIQUE INDEX "translation_entries_key_id_locale_id_key" ON "translation_entries"("key_id", "locale_id");

-- CreateIndex
CREATE INDEX "translation_versions_project_id_created_at_idx" ON "translation_versions"("project_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "translation_versions_entry_id_version_key" ON "translation_versions"("entry_id", "version");

-- CreateIndex
CREATE INDEX "review_tasks_project_id_status_idx" ON "review_tasks"("project_id", "status");

-- CreateIndex
CREATE INDEX "glossary_terms_organization_id_project_id_idx" ON "glossary_terms"("organization_id", "project_id");

-- CreateIndex
CREATE UNIQUE INDEX "translation_memory_entries_organization_id_source_locale_ta_key" ON "translation_memory_entries"("organization_id", "source_locale", "target_locale", "source_hash");

-- CreateIndex
CREATE INDEX "repository_connections_organization_id_idx" ON "repository_connections"("organization_id");

-- CreateIndex
CREATE UNIQUE INDEX "repository_connections_project_id_name_key" ON "repository_connections"("project_id", "name");

-- CreateIndex
CREATE UNIQUE INDEX "repository_file_mappings_connection_id_file_set_id_key" ON "repository_file_mappings"("connection_id", "file_set_id");

-- CreateIndex
CREATE UNIQUE INDEX "sync_scans_scan_id_key" ON "sync_scans"("scan_id");

-- CreateIndex
CREATE INDEX "sync_scans_organization_id_idx" ON "sync_scans"("organization_id");

-- CreateIndex
CREATE INDEX "sync_scans_project_id_created_at_idx" ON "sync_scans"("project_id", "created_at");

-- CreateIndex
CREATE INDEX "sync_sessions_organization_id_idx" ON "sync_sessions"("organization_id");

-- CreateIndex
CREATE INDEX "sync_sessions_project_id_created_at_idx" ON "sync_sessions"("project_id", "created_at");

-- CreateIndex
CREATE INDEX "sync_items_organization_id_idx" ON "sync_items"("organization_id");

-- CreateIndex
CREATE UNIQUE INDEX "sync_items_session_id_platform_namespace_translation_key_lo_key" ON "sync_items"("session_id", "platform", "namespace", "translation_key", "locale_code");

-- CreateIndex
CREATE INDEX "sync_baselines_organization_id_idx" ON "sync_baselines"("organization_id");

-- CreateIndex
CREATE INDEX "sync_baselines_project_id_idx" ON "sync_baselines"("project_id");

-- CreateIndex
CREATE UNIQUE INDEX "sync_baselines_connection_id_platform_namespace_translation_key" ON "sync_baselines"("connection_id", "platform", "namespace", "translation_key", "locale_code");

-- CreateIndex
CREATE UNIQUE INDEX "sync_plans_plan_hash_key" ON "sync_plans"("plan_hash");

-- CreateIndex
CREATE INDEX "sync_plans_organization_id_idx" ON "sync_plans"("organization_id");

-- CreateIndex
CREATE INDEX "sync_plans_project_id_created_at_idx" ON "sync_plans"("project_id", "created_at");

-- CreateIndex
CREATE INDEX "sync_conflicts_organization_id_idx" ON "sync_conflicts"("organization_id");

-- CreateIndex
CREATE INDEX "sync_conflicts_project_id_status_idx" ON "sync_conflicts"("project_id", "status");

-- CreateIndex
CREATE INDEX "sync_apply_reports_organization_id_idx" ON "sync_apply_reports"("organization_id");

-- CreateIndex
CREATE UNIQUE INDEX "sync_apply_reports_session_id_apply_plan_id_key" ON "sync_apply_reports"("session_id", "apply_plan_id");

-- CreateIndex
CREATE INDEX "project_events_project_id_revision_idx" ON "project_events"("project_id", "revision");

-- CreateIndex
CREATE INDEX "project_events_organization_id_idx" ON "project_events"("organization_id");

-- CreateIndex
CREATE UNIQUE INDEX "mcp_clients_token_hash_key" ON "mcp_clients"("token_hash");

-- CreateIndex
CREATE INDEX "mcp_clients_organization_id_idx" ON "mcp_clients"("organization_id");

-- CreateIndex
CREATE INDEX "audit_logs_organization_id_created_at_idx" ON "audit_logs"("organization_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "qa_rules_organization_id_project_id_code_key" ON "qa_rules"("organization_id", "project_id", "code");

-- CreateIndex
CREATE INDEX "qa_runs_project_id_created_at_idx" ON "qa_runs"("project_id", "created_at");

-- CreateIndex
CREATE INDEX "qa_issues_project_id_status_idx" ON "qa_issues"("project_id", "status");

-- CreateIndex
CREATE INDEX "ai_provider_configs_organization_id_idx" ON "ai_provider_configs"("organization_id");

-- CreateIndex
CREATE UNIQUE INDEX "skills_organization_id_slug_version_key" ON "skills"("organization_id", "slug", "version");

-- CreateIndex
CREATE INDEX "releases_project_id_status_idx" ON "releases"("project_id", "status");

-- CreateIndex
CREATE INDEX "release_snapshots_release_id_idx" ON "release_snapshots"("release_id");

-- AddForeignKey
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "projects" ADD CONSTRAINT "projects_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_members" ADD CONSTRAINT "project_members_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_members" ADD CONSTRAINT "project_members_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "locales" ADD CONSTRAINT "locales_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_platforms" ADD CONSTRAINT "project_platforms_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "namespaces" ADD CONSTRAINT "namespaces_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "translation_keys" ADD CONSTRAINT "translation_keys_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "translation_keys" ADD CONSTRAINT "translation_keys_namespace_id_fkey" FOREIGN KEY ("namespace_id") REFERENCES "namespaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "source_versions" ADD CONSTRAINT "source_versions_key_id_fkey" FOREIGN KEY ("key_id") REFERENCES "translation_keys"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "translation_entries" ADD CONSTRAINT "translation_entries_key_id_fkey" FOREIGN KEY ("key_id") REFERENCES "translation_keys"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "translation_entries" ADD CONSTRAINT "translation_entries_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "translation_entries" ADD CONSTRAINT "translation_entries_locale_id_fkey" FOREIGN KEY ("locale_id") REFERENCES "locales"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "translation_versions" ADD CONSTRAINT "translation_versions_entry_id_fkey" FOREIGN KEY ("entry_id") REFERENCES "translation_entries"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "review_tasks" ADD CONSTRAINT "review_tasks_entry_id_fkey" FOREIGN KEY ("entry_id") REFERENCES "translation_entries"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "review_actions" ADD CONSTRAINT "review_actions_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "review_tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "glossary_terms" ADD CONSTRAINT "glossary_terms_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "glossary_terms" ADD CONSTRAINT "glossary_terms_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "translation_memory_entries" ADD CONSTRAINT "translation_memory_entries_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "repository_connections" ADD CONSTRAINT "repository_connections_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "repository_file_mappings" ADD CONSTRAINT "repository_file_mappings_connection_id_fkey" FOREIGN KEY ("connection_id") REFERENCES "repository_connections"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sync_scans" ADD CONSTRAINT "sync_scans_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sync_scans" ADD CONSTRAINT "sync_scans_connection_id_fkey" FOREIGN KEY ("connection_id") REFERENCES "repository_connections"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sync_sessions" ADD CONSTRAINT "sync_sessions_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sync_sessions" ADD CONSTRAINT "sync_sessions_connection_id_fkey" FOREIGN KEY ("connection_id") REFERENCES "repository_connections"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sync_items" ADD CONSTRAINT "sync_items_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "sync_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sync_baselines" ADD CONSTRAINT "sync_baselines_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sync_baselines" ADD CONSTRAINT "sync_baselines_connection_id_fkey" FOREIGN KEY ("connection_id") REFERENCES "repository_connections"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sync_plans" ADD CONSTRAINT "sync_plans_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "sync_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sync_conflicts" ADD CONSTRAINT "sync_conflicts_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sync_conflicts" ADD CONSTRAINT "sync_conflicts_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "sync_sessions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sync_apply_reports" ADD CONSTRAINT "sync_apply_reports_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "sync_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_events" ADD CONSTRAINT "project_events_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mcp_clients" ADD CONSTRAINT "mcp_clients_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mcp_clients" ADD CONSTRAINT "mcp_clients_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "qa_runs" ADD CONSTRAINT "qa_runs_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "qa_issues" ADD CONSTRAINT "qa_issues_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "qa_issues" ADD CONSTRAINT "qa_issues_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "qa_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "qa_issues" ADD CONSTRAINT "qa_issues_entry_id_fkey" FOREIGN KEY ("entry_id") REFERENCES "translation_entries"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_provider_configs" ADD CONSTRAINT "ai_provider_configs_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "skills" ADD CONSTRAINT "skills_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "releases" ADD CONSTRAINT "releases_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "release_snapshots" ADD CONSTRAINT "release_snapshots_release_id_fkey" FOREIGN KEY ("release_id") REFERENCES "releases"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ===========================================================================
-- Multi tenancy: row level security (spec §9.2).
--
-- The application connects as `localehub_app`, which is neither the table owner
-- nor a superuser, so these policies are enforced for it. Every request must set
--   SET LOCAL app.current_org_id = '<organization uuid>';
-- inside its transaction. Platform wide maintenance jobs may set
--   SET LOCAL app.bypass_rls = 'on';
-- which is only reachable through the privileged (owner) connection.
-- ===========================================================================

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'localehub_app') THEN
    CREATE ROLE localehub_app LOGIN PASSWORD 'localehub' NOSUPERUSER NOBYPASSRLS;
  END IF;
END
$$;

GRANT USAGE ON SCHEMA public TO localehub_app;

CREATE OR REPLACE FUNCTION current_organization_id() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.current_org_id', true), '')::uuid
$$;

CREATE OR REPLACE FUNCTION rls_bypassed() RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT current_setting('app.bypass_rls', true) = 'on'
$$;


ALTER TABLE "memberships" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "memberships";
CREATE POLICY tenant_isolation ON "memberships"
  USING (organization_id = current_organization_id() OR rls_bypassed())
  WITH CHECK (organization_id = current_organization_id() OR rls_bypassed());

ALTER TABLE "projects" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "projects";
CREATE POLICY tenant_isolation ON "projects"
  USING (organization_id = current_organization_id() OR rls_bypassed())
  WITH CHECK (organization_id = current_organization_id() OR rls_bypassed());

ALTER TABLE "project_members" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "project_members";
CREATE POLICY tenant_isolation ON "project_members"
  USING (organization_id = current_organization_id() OR rls_bypassed())
  WITH CHECK (organization_id = current_organization_id() OR rls_bypassed());

ALTER TABLE "locales" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "locales";
CREATE POLICY tenant_isolation ON "locales"
  USING (organization_id = current_organization_id() OR rls_bypassed())
  WITH CHECK (organization_id = current_organization_id() OR rls_bypassed());

ALTER TABLE "project_platforms" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "project_platforms";
CREATE POLICY tenant_isolation ON "project_platforms"
  USING (organization_id = current_organization_id() OR rls_bypassed())
  WITH CHECK (organization_id = current_organization_id() OR rls_bypassed());

ALTER TABLE "namespaces" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "namespaces";
CREATE POLICY tenant_isolation ON "namespaces"
  USING (organization_id = current_organization_id() OR rls_bypassed())
  WITH CHECK (organization_id = current_organization_id() OR rls_bypassed());

ALTER TABLE "translation_keys" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "translation_keys";
CREATE POLICY tenant_isolation ON "translation_keys"
  USING (organization_id = current_organization_id() OR rls_bypassed())
  WITH CHECK (organization_id = current_organization_id() OR rls_bypassed());

ALTER TABLE "source_versions" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "source_versions";
CREATE POLICY tenant_isolation ON "source_versions"
  USING (organization_id = current_organization_id() OR rls_bypassed())
  WITH CHECK (organization_id = current_organization_id() OR rls_bypassed());

ALTER TABLE "translation_entries" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "translation_entries";
CREATE POLICY tenant_isolation ON "translation_entries"
  USING (organization_id = current_organization_id() OR rls_bypassed())
  WITH CHECK (organization_id = current_organization_id() OR rls_bypassed());

ALTER TABLE "translation_versions" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "translation_versions";
CREATE POLICY tenant_isolation ON "translation_versions"
  USING (organization_id = current_organization_id() OR rls_bypassed())
  WITH CHECK (organization_id = current_organization_id() OR rls_bypassed());

ALTER TABLE "review_tasks" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "review_tasks";
CREATE POLICY tenant_isolation ON "review_tasks"
  USING (organization_id = current_organization_id() OR rls_bypassed())
  WITH CHECK (organization_id = current_organization_id() OR rls_bypassed());

ALTER TABLE "glossary_terms" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "glossary_terms";
CREATE POLICY tenant_isolation ON "glossary_terms"
  USING (organization_id = current_organization_id() OR rls_bypassed())
  WITH CHECK (organization_id = current_organization_id() OR rls_bypassed());

ALTER TABLE "translation_memory_entries" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "translation_memory_entries";
CREATE POLICY tenant_isolation ON "translation_memory_entries"
  USING (organization_id = current_organization_id() OR rls_bypassed())
  WITH CHECK (organization_id = current_organization_id() OR rls_bypassed());

ALTER TABLE "repository_connections" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "repository_connections";
CREATE POLICY tenant_isolation ON "repository_connections"
  USING (organization_id = current_organization_id() OR rls_bypassed())
  WITH CHECK (organization_id = current_organization_id() OR rls_bypassed());

ALTER TABLE "repository_file_mappings" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "repository_file_mappings";
CREATE POLICY tenant_isolation ON "repository_file_mappings"
  USING (organization_id = current_organization_id() OR rls_bypassed())
  WITH CHECK (organization_id = current_organization_id() OR rls_bypassed());

ALTER TABLE "sync_scans" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "sync_scans";
CREATE POLICY tenant_isolation ON "sync_scans"
  USING (organization_id = current_organization_id() OR rls_bypassed())
  WITH CHECK (organization_id = current_organization_id() OR rls_bypassed());

ALTER TABLE "sync_sessions" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "sync_sessions";
CREATE POLICY tenant_isolation ON "sync_sessions"
  USING (organization_id = current_organization_id() OR rls_bypassed())
  WITH CHECK (organization_id = current_organization_id() OR rls_bypassed());

ALTER TABLE "sync_items" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "sync_items";
CREATE POLICY tenant_isolation ON "sync_items"
  USING (organization_id = current_organization_id() OR rls_bypassed())
  WITH CHECK (organization_id = current_organization_id() OR rls_bypassed());

ALTER TABLE "sync_baselines" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "sync_baselines";
CREATE POLICY tenant_isolation ON "sync_baselines"
  USING (organization_id = current_organization_id() OR rls_bypassed())
  WITH CHECK (organization_id = current_organization_id() OR rls_bypassed());

ALTER TABLE "sync_plans" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "sync_plans";
CREATE POLICY tenant_isolation ON "sync_plans"
  USING (organization_id = current_organization_id() OR rls_bypassed())
  WITH CHECK (organization_id = current_organization_id() OR rls_bypassed());

ALTER TABLE "sync_conflicts" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "sync_conflicts";
CREATE POLICY tenant_isolation ON "sync_conflicts"
  USING (organization_id = current_organization_id() OR rls_bypassed())
  WITH CHECK (organization_id = current_organization_id() OR rls_bypassed());

ALTER TABLE "sync_apply_reports" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "sync_apply_reports";
CREATE POLICY tenant_isolation ON "sync_apply_reports"
  USING (organization_id = current_organization_id() OR rls_bypassed())
  WITH CHECK (organization_id = current_organization_id() OR rls_bypassed());

ALTER TABLE "project_events" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "project_events";
CREATE POLICY tenant_isolation ON "project_events"
  USING (organization_id = current_organization_id() OR rls_bypassed())
  WITH CHECK (organization_id = current_organization_id() OR rls_bypassed());

ALTER TABLE "mcp_clients" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "mcp_clients";
CREATE POLICY tenant_isolation ON "mcp_clients"
  USING (organization_id = current_organization_id() OR rls_bypassed())
  WITH CHECK (organization_id = current_organization_id() OR rls_bypassed());

ALTER TABLE "audit_logs" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "audit_logs";
CREATE POLICY tenant_isolation ON "audit_logs"
  USING (organization_id = current_organization_id() OR rls_bypassed())
  WITH CHECK (organization_id = current_organization_id() OR rls_bypassed());

ALTER TABLE "qa_rules" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "qa_rules";
CREATE POLICY tenant_isolation ON "qa_rules"
  USING (organization_id = current_organization_id() OR rls_bypassed())
  WITH CHECK (organization_id = current_organization_id() OR rls_bypassed());

ALTER TABLE "qa_runs" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "qa_runs";
CREATE POLICY tenant_isolation ON "qa_runs"
  USING (organization_id = current_organization_id() OR rls_bypassed())
  WITH CHECK (organization_id = current_organization_id() OR rls_bypassed());

ALTER TABLE "qa_issues" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "qa_issues";
CREATE POLICY tenant_isolation ON "qa_issues"
  USING (organization_id = current_organization_id() OR rls_bypassed())
  WITH CHECK (organization_id = current_organization_id() OR rls_bypassed());

ALTER TABLE "ai_provider_configs" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "ai_provider_configs";
CREATE POLICY tenant_isolation ON "ai_provider_configs"
  USING (organization_id = current_organization_id() OR rls_bypassed())
  WITH CHECK (organization_id = current_organization_id() OR rls_bypassed());

ALTER TABLE "skills" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "skills";
CREATE POLICY tenant_isolation ON "skills"
  USING (organization_id = current_organization_id() OR rls_bypassed())
  WITH CHECK (organization_id = current_organization_id() OR rls_bypassed());

ALTER TABLE "releases" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "releases";
CREATE POLICY tenant_isolation ON "releases"
  USING (organization_id = current_organization_id() OR rls_bypassed())
  WITH CHECK (organization_id = current_organization_id() OR rls_bypassed());

ALTER TABLE "release_snapshots" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "release_snapshots";
CREATE POLICY tenant_isolation ON "release_snapshots"
  USING (organization_id = current_organization_id() OR rls_bypassed())
  WITH CHECK (organization_id = current_organization_id() OR rls_bypassed());

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO localehub_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO localehub_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO localehub_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO localehub_app;
