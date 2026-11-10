import { z } from 'zod';
import { localeTagSchema, platformSchema } from './schemas';

/**
 * Canonical registry of the Remote MCP's tools. Shared by the server, the API's discovery
 * endpoint and the documentation generator so that all three stay in sync (spec §6.4).
 *
 * There is no local registry: the platform exposes exactly one MCP, and work on a developer's
 * checkout is the CLI's job rather than an MCP server's. See `docs/MCP.md`.
 */

/**
 * Resources the Remote MCP registers that are not per-skill.
 *
 * Listed here so the discovery endpoint and the server cannot disagree: the endpoint used to
 * advertise six `localehub://projects/...` resources that neither server ever registered.
 */
export const REMOTE_MCP_RESOURCES = ['localehub://qa-rules'] as const;

/**
 * Hand-written prompts the Remote MCP registers.
 *
 * The per-skill prompts (`skill-<slug>`) are generated from what an organization has published, so
 * they are not listed here — read `localehub://skills` for those.
 */
export const REMOTE_MCP_PROMPTS = ['review-localization-changes', 'fix-translation-issues'] as const;

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
