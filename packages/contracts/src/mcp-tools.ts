import { z } from 'zod';
import { localeTagSchema, platformSchema } from './schemas';

/**
 * Canonical registry of MCP tools. Shared by the Local MCP, the Remote MCP and the
 * documentation generator so that all three stay in sync (spec §6.2, §6.4).
 */

export const LOCAL_MCP_TOOLS = [
  'get_local_project_info',
  'scan_local_project',
  'read_project_context',
  'get_remote_project',
  'preview_sync',
  'push_project_changes',
  'pull_platform_updates',
  'preview_apply',
  'apply_translation_updates',
  'validate_localization_files',
  'get_sync_status',
  'resolve_sync_conflict',
  'report_apply_result',
  'create_git_patch',
] as const;
export type LocalMcpTool = (typeof LOCAL_MCP_TOOLS)[number];

export const REMOTE_MCP_TOOLS = [
  'list_projects',
  'get_project',
  'list_project_locales',
  'search_translation_keys',
  'get_translation_entry',
  'get_glossary',
  'search_translation_memory',
  'translate_entries',
  'review_translation_entries',
  'get_qa_issues',
  'update_translation_draft',
  'submit_review',
  'get_project_sync_status',
  'get_pending_platform_changes',
  'validate_release',
] as const;
export type RemoteMcpTool = (typeof REMOTE_MCP_TOOLS)[number];

export const localToolSchemas = {
  get_local_project_info: z.object({}),
  scan_local_project: z.object({
    project_id: z.string().optional(),
    file_set_ids: z.array(z.string()).optional(),
    include_context: z.boolean().default(false),
  }),
  read_project_context: z.object({
    glob: z.string().min(1),
    max_files: z.number().int().positive().max(50).default(5),
    max_bytes_per_file: z.number().int().positive().max(200_000).default(20_000),
  }),
  get_remote_project: z.object({ project_id: z.string().optional() }),
  preview_sync: z.object({
    project_id: z.string().optional(),
    direction: z.enum(['bidirectional', 'push', 'pull']).default('bidirectional'),
    scan_id: z.string().optional(),
    include_deletes: z.boolean().default(false),
    include_drafts: z.boolean().default(false),
    file_set_ids: z.array(z.string()).optional(),
    locales: z.array(localeTagSchema).optional(),
  }),
  push_project_changes: z.object({
    preview_id: z.string().optional(),
    sync_plan_id: z.string().optional(),
    confirm: z.boolean().default(false),
    idempotency_key: z.string().optional(),
    include_deletes: z.boolean().default(false),
  }),
  pull_platform_updates: z.object({
    project_id: z.string().optional(),
    locales: z.array(localeTagSchema).optional(),
    statuses: z.array(z.enum(['DRAFT', 'PENDING_REVIEW', 'APPROVED', 'REJECTED', 'STALE'])).default(['APPROVED']),
    since_revision: z.union([z.string(), z.number()]).optional(),
    include_drafts: z.boolean().default(false),
    limit: z.number().int().positive().max(2000).default(500),
  }),
  preview_apply: z.object({
    project_id: z.string().optional(),
    change_ids: z.array(z.string()).optional(),
    dry_run: z.boolean().default(true),
    create_backup: z.boolean().default(true),
    include_drafts: z.boolean().default(false),
  }),
  apply_translation_updates: z.object({
    apply_plan_id: z.string().min(1),
    confirm: z.boolean().default(false),
    require_clean_worktree: z.boolean().default(false),
    create_backup: z.boolean().default(true),
  }),
  validate_localization_files: z
    .object({
      file_set_ids: z.array(z.string()).optional(),
      check_placeholders: z.boolean().default(true),
      check_duplicates: z.boolean().default(true),
      check_missing: z.boolean().default(true),
    })
    .default({}),
  get_sync_status: z.object({
    project_id: z.string().optional(),
    include_conflicts: z.boolean().default(true),
  }),
  resolve_sync_conflict: z.object({
    conflict_id: z.string().min(1),
    resolution: z.enum(['KEEP_LOCAL', 'KEEP_REMOTE', 'MANUAL_MERGE', 'DEFER']),
    value: z.string().optional(),
    note: z.string().optional(),
  }),
  report_apply_result: z.object({
    apply_plan_id: z.string().min(1),
    git_commit: z.string().nullable().optional(),
    note: z.string().optional(),
  }),
  create_git_patch: z.object({
    apply_plan_id: z.string().optional(),
    output_path: z.string().optional(),
    include_untracked: z.boolean().default(true),
  }),
} satisfies Record<LocalMcpTool, z.ZodTypeAny>;

export const remoteToolSchemas = {
  list_projects: z.object({}),
  get_project: z.object({ project_id: z.string() }),
  list_project_locales: z.object({ project_id: z.string() }),
  search_translation_keys: z.object({
    project_id: z.string(),
    query: z.string().optional(),
    locale: localeTagSchema.optional(),
    status: z.enum(['DRAFT', 'PENDING_REVIEW', 'APPROVED', 'REJECTED', 'STALE', 'UNTRANSLATED']).optional(),
    platform: platformSchema.optional(),
    limit: z.number().int().positive().max(200).default(50),
    cursor: z.string().optional(),
  }),
  get_translation_entry: z.object({ project_id: z.string(), key: z.string(), locale: localeTagSchema }),
  get_glossary: z.object({ project_id: z.string(), locale: localeTagSchema.optional() }),
  search_translation_memory: z.object({
    project_id: z.string(),
    query: z.string().min(1),
    locale: localeTagSchema.optional(),
    limit: z.number().int().positive().max(50).default(10),
  }),
  translate_entries: z.object({
    project_id: z.string(),
    entry_ids: z.array(z.string()).min(1).max(200),
    target_locales: z.array(localeTagSchema).min(1),
    provider: z.string().optional(),
    write_drafts: z.boolean().default(true),
  }),
  review_translation_entries: z.object({
    project_id: z.string(),
    entry_ids: z.array(z.string()).min(1).max(500),
    locales: z.array(localeTagSchema).optional(),
    decision: z.enum(['APPROVE', 'REJECT']),
    comment: z.string().optional(),
  }),
  get_qa_issues: z.object({
    project_id: z.string(),
    locale: localeTagSchema.optional(),
    severity: z.enum(['ERROR', 'WARNING', 'INFO']).optional(),
    limit: z.number().int().positive().max(200).default(50),
  }),
  update_translation_draft: z.object({
    project_id: z.string(),
    key: z.string(),
    locale: localeTagSchema,
    value: z.string(),
    expected_revision: z.number().int().nonnegative().optional(),
  }),
  submit_review: z.object({
    project_id: z.string(),
    entry_ids: z.array(z.string()).min(1),
    locales: z.array(localeTagSchema).optional(),
    comment: z.string().optional(),
  }),
  get_project_sync_status: z.object({ project_id: z.string() }),
  get_pending_platform_changes: z.object({
    project_id: z.string(),
    locale: localeTagSchema.optional(),
    status: z.enum(['DRAFT', 'PENDING_REVIEW', 'APPROVED']).default('APPROVED'),
    since_revision: z.number().int().nonnegative().optional(),
    limit: z.number().int().positive().max(500).default(100),
  }),
  validate_release: z.object({
    project_id: z.string(),
    locales: z.array(localeTagSchema).optional(),
    fail_on: z.enum(['ERROR', 'WARNING']).default('ERROR'),
  }),
} satisfies Record<RemoteMcpTool, z.ZodTypeAny>;
