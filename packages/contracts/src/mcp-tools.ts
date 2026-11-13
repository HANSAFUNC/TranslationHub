import { z } from 'zod';
import { McpScope } from './roles';
import { localeTagSchema, platformSchema } from './schemas';
import { MAX_MARKERS_PER_MOCKUP, MAX_MOCKUP_BYTES, MAX_MOCKUP_REQUEST_BYTES, markerSchema } from './mockup';

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
  'upload_screen_mockup',
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
  // Repository → platform, like `import_translations`: the caller is handing over what it read from
  // the checkout, and the mockup is part of that reading. It is not a translation write (nothing a
  // translator would type) and not an apply (nothing is written into anyone's repository), so the
  // scope that already means "put local content on the platform" is the right one.
  upload_screen_mockup: [McpScope.SYNC_PUSH],
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
      '源语言。必填且此后无法修改：平台没有改 sourceLocale 的工具。选错只能重建项目——所以先确认仓库里的源语言目录叫什么，再决定用哪个标签。',
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
            '该文件的语言，按仓库里的实际目录填（zh-Hans.lproj 就传 zh-Hans）。等价标签会归入项目已有的语言（zh-Hans → zh-CN、en → en-US），项目没有的会自动新增，两者都会在返回值的 expansion 里报告；只有无法判断时（项目同时有 zh-CN 和 zh-TW 而来的是 zh）才会拒绝。',
          ),
          platform: platformSchema
            .default('web')
            .describe(
              "该文件的端。默认是 web：iOS 请传 'ios'，Android 传 'android'，多端共用文案传 'universal'。platform 是 key 身份的一部分，必须与 .localehub/config.yaml 里映射的 platform 一致；项目没声明这个端时会自动加上。",
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
  /**
   * The half of context a key cannot carry.
   *
   * A key says what a string is; it cannot say where it appears, so a reviewer looking at
   * `checkout.pay_now` has to imagine the button. This tool uploads that missing half — a sketch of
   * the screen plus one marker per key marking where its text sits — and the translation editor shows
   * the two side by side, clicking either highlighting the other.
   *
   * Uploaded by the caller rather than fetched by the platform for the same reason as
   * `import_translations`: the platform cannot see the caller's disk.
   */
  upload_screen_mockup: z.object({
    project_id: z.string().describe('项目 id（list_projects 可取）'),
    name: z
      .string()
      .min(1)
      .max(120)
      .describe('这个界面的名字，如 "checkout" 或 "登录页"。它是屏幕的身份：同一个名字再传一次会整体替换（图片与标记），不会堆积 checkout-2、checkout-final。'),
    platform: platformSchema
      .default('web')
      .describe(
        '这张草图对应的端，默认 web。标记按 key + namespace 匹配，不按端；当项目的同名 key 存在于多个端时，优先取这个端的那一条，' +
          '取到别的端会在编辑器里标出来（「Key 在 web，不在 ios」）。',
      ),
    locale: localeTagSchema.describe(
      '草图里文字用的语言，通常就是项目源语言。它只描述这张图，不参与 key 的身份。',
    ),
    image_base64: z
      .string()
      .min(1)
      .describe(
        `草图本身，base64（可以带 data: 前缀）。支持 SVG / PNG / JPEG，解码后不超过 ${Math.round(MAX_MOCKUP_BYTES / 1024 / 1024)} MB。` +
          `整个请求（图片 + 标记的 text/note）共用 ${Math.round(MAX_MOCKUP_REQUEST_BYTES / 1024 / 1024)} MB 的传输上限，base64 会让图片占约 1.37 倍——超了整单会被拒。` +
          'SVG 最省事也最清晰，适合自己画一张线框图；不要在里面放 <script>、事件属性或 <foreignObject>，会被拒绝。',
      ),
    mime_type: z
      .enum(['image/svg+xml', 'image/png', 'image/jpeg'])
      .optional()
      .describe('图片格式。可以不传：平台按字节判断真实格式，传错也不会写错 content-type。WebP 不支持——平台读不出它的像素尺寸，就不敢替浏览器收下它。'),
    width: z.number().int().positive().max(8192).optional().describe('图片像素宽（可选，记下来给编辑器预留位置用）'),
    height: z.number().int().positive().max(8192).optional().describe('图片像素高（可选）'),
    markers: z
      .array(markerSchema)
      .min(1)
      .max(MAX_MARKERS_PER_MOCKUP)
      .describe(
        '每个标记指向界面上一个 key 的位置。坐标是**相对图片的比例 0~1**，不是像素：x 是左边缘占宽的比例，y 是上边缘占高的比例,' +
          'width/height 可选（省略就画一个点）。比例坐标的好处是同一张图在任何尺寸下都对齐，设计师换 2x 导出也不用重标。' +
          'markers[].text 填图里显示的文字，编辑器可以据此提示「草图与平台原文不一致」。',
      ),
    replace: z
      .boolean()
      .default(true)
      .describe('同名屏幕已存在时是否替换，默认 true。传 false 则报冲突而不是覆盖。'),
  }),
} satisfies Record<RemoteMcpTool, z.ZodTypeAny>;
