import { z } from 'zod';
import { McpScope } from './roles';
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
  'create_project',
  'import_translations',
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
  'mark_applied',
  'validate_release',
] as const;
export type RemoteMcpTool = (typeof REMOTE_MCP_TOOLS)[number];

/**
 * The scope each tool requires, mirroring the `@RequireScopes` on the REST route that does the
 * same job. A tool with no entry needs only the role its handler asserts.
 *
 * The MCP server enforced roles but no scopes at all: a token issued for `project.read` alone could
 * call `import_translations` and write. That made every scope a decoration on the one surface where
 * the spec leans on them hardest — §2.2 requires `sync.push` and `translation.apply` to be
 * separately granted, and `mark_applied` is precisely the operation `translation.apply` exists for.
 */
export const REMOTE_MCP_TOOL_SCOPES: Partial<Record<RemoteMcpTool, McpScope[]>> = {
  // scan → preview → push, the three REST routes this tool replaces.
  import_translations: [McpScope.REPOSITORY_SCAN, McpScope.SYNC_PREVIEW, McpScope.SYNC_PUSH],
  review_translation_entries: [McpScope.TRANSLATION_REVIEW],
  update_translation_draft: [McpScope.TRANSLATION_WRITE],
  mark_applied: [McpScope.TRANSLATION_APPLY],
};

export const remoteToolSchemas = {
  /**
   * Bootstrap: the two tools that let an agent set a project up from a repository it can read.
   *
   * The platform cannot see the developer's disk, so the agent reads the language files with its
   * own tools and hands the content over. That is why these are Remote MCP tools rather than a
   * server-side importer: the only party that can read the checkout is the agent.
   */
  create_project: z.object({
    name: z.string().min(1).max(120),
    source_locale: localeTagSchema,
    locales: z.array(localeTagSchema).max(50).optional(),
    platforms: z.array(platformSchema).max(5).optional(),
    description: z.string().max(2000).optional(),
    /** Where the repository keeps its language files; shapes the config this returns. */
    locales_dir: z.string().max(200).optional(),
  }),
  import_translations: z.object({
    project_id: z.string(),
    files: z
      .array(
        z.object({
          path: z.string().min(1),
          locale: localeTagSchema,
          platform: platformSchema.default('web'),
          namespace: z.string().max(255).optional(),
          entries: z.array(z.object({ key: z.string().min(1).max(512), value: z.string() })).min(1).max(20000),
        }),
      )
      .min(1)
      .max(500),
    /** Apply the import. Without it the call only reports what would happen. */
    confirm: z.boolean().default(false),
  }),
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
  /**
   * The other half of `get_pending_platform_changes`.
   *
   * An agent that reads approved changes and writes them into the checkout has to be able to say
   * so, or the platform keeps offering the same work and `validate_release` keeps counting it as
   * outstanding. This is a claim about a machine the platform cannot see — the same claim a CLI
   * apply report makes — so each item names the version that was written, and a version the
   * platform has since superseded is refused instead of marked.
   */
  mark_applied: z.object({
    project_id: z.string(),
    items: z
      .array(
        z.object({
          key: z.string().min(1),
          locale: localeTagSchema,
          platform: platformSchema,
          file_path: z.string().max(500).optional(),
          translation_version_id: z.string().optional(),
        }),
      )
      .min(1)
      .max(500),
    /** `true` reports what would be marked without writing anything. Defaults to false. */
    dry_run: z.boolean().default(false),
    git_commit: z.string().max(100).optional(),
    git_branch: z.string().max(200).optional(),
  }),
  validate_release: z.object({
    project_id: z.string(),
    locales: z.array(localeTagSchema).optional(),
    fail_on: z.enum(['ERROR', 'WARNING']).default('ERROR'),
  }),
} satisfies Record<RemoteMcpTool, z.ZodTypeAny>;
