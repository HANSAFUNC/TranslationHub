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
export const REMOTE_MCP_RESOURCES = ['localehub://qa-rules', 'localehub://import-guide'] as const;

/**
 * Hand-written prompts the Remote MCP registers.
 *
 * The per-skill prompts (`skill-<slug>`) are generated from what an organization has published, so
 * they are not listed here — read `localehub://skills` for those.
 */
export const REMOTE_MCP_PROMPTS = ['review-localization-changes', 'fix-translation-issues', 'import-localization-files'] as const;

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
    name: z.string().min(1).max(120).describe('项目名'),
    source_locale: localeTagSchema.describe(
      '源语言。必填且此后无法修改：平台没有改 sourceLocale 的工具。语言文件里的语言必须与它逐字符相同才会被当作源文（zh-Hans 与 zh-CN 不同）。',
    ),
    locales: z
      .array(localeTagSchema)
      .max(50)
      .optional()
      .describe('目标语言列表，源语言会自动加入。推导自仓库里实际存在的语言目录。'),
    platforms: z
      .array(platformSchema)
      .max(5)
      .optional()
      .describe(
        "项目涉及的端，默认 ['web']。必须与稍后导入时传的 platform、以及 .localehub/config.yaml 里的 platform 一致——platform 是 key 身份的一部分。",
      ),
    description: z.string().max(2000).optional().describe('项目描述'),
    locales_dir: z
      .string()
      .max(200)
      .optional()
      .describe('仓库里语言文件的目录（如 "locales" 或 "ios/Resources"）；只影响返回的配置文件内容'),
  }),
  import_translations: z.object({
    project_id: z.string().describe('目标项目 id（list_projects 可取）'),
    files: z
      .array(
        z.object({
          path: z.string().min(1).describe('仓库里的相对路径，仅作标识，不参与 key 身份'),
          locale: localeTagSchema.describe(
            '该文件的语言。必须与项目里的 locale 代码逐字符相同，源语言文件还必须等于项目 sourceLocale——平台不做 zh-Hans ↔ zh-CN 之类的等价映射，传错会导致一条 source version 都不生成。',
          ),
          platform: platformSchema
            .default('web')
            .describe(
              "该文件的端。默认是 web：iOS 请传 'ios'，Android 传 'android'，多端共用文案传 'universal'。platform 是 key 身份的一部分，必须与 .localehub/config.yaml 里映射的 platform 一致。",
            ),
          namespace: z
            .string()
            .max(255)
            .optional()
            .describe(
              '命名空间，默认空。同一端下有多张字符串表时必须用它区分（iOS 的 Localizable / InfoPlist / LaunchScreen）——key 身份里没有文件路径，不区分就会互相覆盖。',
            ),
          entries: z
            .array(
              z
                .object({ key: z.string().min(1).max(512).describe('键名'), value: z.string().describe('该语言的文本') })
                .describe('一条 key/value'),
            )
            .min(1)
            .max(20000)
            .describe(
              '本文件的全部条目。schema 允许到 20000，但一次调用请控制在 300~400 条：整个导入在一个 5 秒的事务里，超时整批回滚。',
            ),
        }),
      )
      .min(1)
      .max(500)
      .describe('要导入的文件列表。按「文件 × 语言」拆开，每批 300~400 条。'),
    confirm: z
      .boolean()
      .default(false)
      .describe('默认 false = 只报告会写入什么，不落库。先跑 dry run 核对 isSource 与条目数，再传 true。'),
  }),
  list_projects: z.object({}).describe('列出当前 Token 可访问的项目；只返回你自己的，不会看到别人的'),
  get_project: z.object({ project_id: z.string().describe('项目 id') }),
  list_project_locales: z
    .object({ project_id: z.string().describe('项目 id') })
    .describe('读项目的语言列表。导入前先调它拿到确切的 locale 代码（含 sourceLocale），不要猜。'),
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
    project_id: z.string().describe('项目 id'),
    entry_ids: z.array(z.string()).min(1).max(500).describe('条目 id（search_translation_keys 可取）'),
    locales: z.array(localeTagSchema).optional().describe('只处理这些语言；省略表示全部'),
    decision: z.enum(['APPROVE', 'REJECT']).describe('审核决定。需要 REVIEWER 角色——Agent 通常没有，会被拒绝'),
    comment: z.string().optional().describe('审核备注'),
  }),
  get_qa_issues: z.object({
    project_id: z.string(),
    locale: localeTagSchema.optional(),
    severity: z.enum(['ERROR', 'WARNING', 'INFO']).optional(),
    limit: z.number().int().positive().max(200).default(50),
  }),
  update_translation_draft: z.object({
    project_id: z.string().describe('项目 id'),
    key: z.string().describe('键名'),
    locale: localeTagSchema.describe('目标语言'),
    value: z.string().describe('新的译文文本；会写成新版本，不覆盖历史'),
    expected_revision: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe('乐观并发：传当前 revision，若期间被人改过则报 409 而不是盲目覆盖'),
  }),
  submit_review: z.object({
    project_id: z.string(),
    entry_ids: z.array(z.string()).min(1),
    locales: z.array(localeTagSchema).optional(),
    comment: z.string().optional(),
  }),
  get_project_sync_status: z.object({ project_id: z.string() }),
  get_pending_platform_changes: z.object({
    project_id: z.string().describe('项目 id'),
    locale: localeTagSchema.optional().describe('只看这些语言；省略表示全部'),
    status: z
      .enum(['DRAFT', 'PENDING_REVIEW', 'APPROVED'])
      .default('APPROVED')
      .describe('取哪些审核状态的译文，默认只看已审核的。未审核的草稿写入仓库需要组织开启 allowDraftApply'),
    since_revision: z.number().int().nonnegative().optional().describe('只取该 revision 之后的变更（断点续传）'),
    limit: z.number().int().positive().max(500).default(100).describe('最多返回多少条'),
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
    project_id: z.string().describe('项目 id'),
    items: z
      .array(
        z
          .object({
            key: z.string().min(1).describe('键名'),
            locale: localeTagSchema.describe('语言'),
            platform: platformSchema.describe('端。要与导入/仓库配置里用的一致，否则找不到这条 key'),
            file_path: z.string().max(500).optional().describe('写到了哪个文件，仅作记录'),
            translation_version_id: z
              .string()
              .optional()
              .describe(
                '你实际写入的版本，取自 get_pending_platform_changes。带上它平台才能校验你写的是不是当前版本；版本已被平台更新过则拒绝标记',
              ),
          })
          .describe('一条已写回仓库的译文'),
      )
      .min(1)
      .max(500)
      .describe('你确实已写进仓库的条目'),
    dry_run: z.boolean().default(false).describe('true = 只报告会标记什么，不写库也不建 session'),
    git_commit: z.string().max(100).optional().describe('写入时的 commit，记录到 applied_to_repo_commit'),
    git_branch: z.string().max(200).optional().describe('写入时的分支'),
  }),
  validate_release: z.object({
    project_id: z.string(),
    locales: z.array(localeTagSchema).optional(),
    fail_on: z.enum(['ERROR', 'WARNING']).default('ERROR'),
  }),
} satisfies Record<RemoteMcpTool, z.ZodTypeAny>;
