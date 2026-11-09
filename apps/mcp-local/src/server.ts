import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ZodRawShape } from 'zod';

/**
 * The SDK's registerTool is heavily generic; the union of 14 tool schemas exceeds TypeScript's
 * instantiation depth. We keep the strong types at the call sites and erase them exactly here.
 */
type RegisterToolFn = (
  name: string,
  config: { description: string; inputSchema: ZodRawShape; annotations?: Record<string, unknown> },
  handler: (input: unknown) => Promise<unknown>,
) => void;
import {
  ErrorCode,
  LocaleHubError,
  localToolSchemas,
  type LocalMcpTool,
} from '@localehub/contracts';
import { LocalMcpServices, type ToolContext } from './services';

const SERVER_NAME = 'localehub-local';
const SERVER_VERSION = '0.1.0';

const INSTRUCTIONS = `LocaleHub Local MCP — 安全地在本地仓库与 LocaleHub 平台之间同步本地化资源。

必须遵守的顺序：
1. 任何 push 或写文件前，先调用 preview_sync / preview_apply 并把差异展示给用户。
2. 只有用户明确同意后，才用 confirm=true 调用 push_project_changes / apply_translation_updates。
3. 默认只拉取 APPROVED 译文；草稿需要 include_drafts=true 且用户明确同意。
4. 绝不静默覆盖本地改动；遇到冲突调用 resolve_sync_conflict 并让用户选择。
5. 不执行 git commit / push，除非用户单独授权。
6. 汇报同步会话、写入文件、跳过与冲突条目。`;

/** JSON-safe tool result: MCP expects text content, so we also emit structuredContent. */
function ok(payload: unknown) {
  const text = JSON.stringify(payload, null, 2);
  // MCP requires structuredContent to be an object; arrays and primitives are wrapped.
  const normalised = JSON.parse(text) as unknown;
  const structuredContent =
    normalised && typeof normalised === 'object' && !Array.isArray(normalised)
      ? (normalised as Record<string, unknown>)
      : { items: normalised };
  return {
    content: [{ type: 'text' as const, text }],
    structuredContent,
  };
}

function fail(error: unknown) {
  const err = error instanceof LocaleHubError ? error : LocaleHubError.from(error);
  return {
    isError: true,
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify({ success: false, error: { code: err.code, message: err.message, details: err.details ?? null } }, null, 2),
      },
    ],
    structuredContent: { success: false, error: { code: err.code, message: err.message } },
  };
}

/**
 * Build the Local MCP server with all 14 required tools (spec §6.2).
 *
 * The server only exposes the tools; authorization is enforced by the platform for anything
 * that touches remote data, and by the workspace guard for anything that touches disk.
 */
export function buildLocalMcpServer(services: LocalMcpServices): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { instructions: INSTRUCTIONS, capabilities: { tools: {}, resources: {}, prompts: {} } },
  );

  const registerTool = server.registerTool.bind(server) as unknown as RegisterToolFn;

  const register = <K extends LocalMcpTool>(
    name: K,
    description: string,
    annotations: { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean },
    handler: (input: never) => Promise<unknown> | unknown,
  ) => {
    const schema = localToolSchemas[name] as unknown as { shape?: ZodRawShape; _def?: { schema?: { shape?: ZodRawShape } } };
    const shape = schema.shape ?? schema._def?.schema?.shape ?? {};
    registerTool(
      name,
      {
        description,
        inputSchema: shape,
        annotations,
      },
      async (input: unknown) => {
        try {
          return ok(await Promise.resolve(handler(input as never)));
        } catch (error) {
          return fail(error);
        }
      },
    );
  };

  /* ------------------------------------------------------------------ read only */

  register('get_local_project_info', '读取 .localehub/config.yaml、workspace root、Git 分支/commit、同步策略与上次同步状态（只读）。', { readOnlyHint: true }, () =>
    services.getLocalProjectInfo(),
  );

  register('scan_local_project', '扫描配置声明的语言资源文件并规范化，返回文件数/Key 数/Locale/解析警告（只读，但会把规范化条目上传到平台供比对）。', { readOnlyHint: true }, (input: { project_id?: string; file_set_ids?: string[] }) =>
    services.scanLocalProject(input),
  );

  register('read_project_context', '在 workspace.allowRead 白名单内读取源码/注释上下文（只读；不会默认上传）。', { readOnlyHint: true }, (input: { glob: string; max_files: number; max_bytes_per_file: number }) =>
    services.readProjectContext(input),
  );

  register('get_remote_project', '读取平台项目、语言与同步配置（只读）。', { readOnlyHint: true }, (input: { project_id?: string }) =>
    services.getRemoteProject(input),
  );

  register('preview_sync', '本地与平台三方比较，生成变更计划（只读，不写入任何一方）。', { readOnlyHint: true }, (input: Parameters<LocalMcpServices['previewSync']>[0]) =>
    services.previewSync(input),
  );

  register('pull_platform_updates', '查询平台译文变更，默认只返回 APPROVED（只读）。', { readOnlyHint: true }, (input: Parameters<LocalMcpServices['pullPlatformUpdates']>[0]) =>
    services.pullPlatformUpdates(input),
  );

  register('preview_apply', '根据平台变更生成回写 patch：文件、Key、旧值、新值、风险（dry-run，不写文件）。', { readOnlyHint: true }, (input: Parameters<LocalMcpServices['previewApply']>[0]) =>
    services.previewApply(input),
  );

  register('validate_localization_files', '本地格式、占位符、重复 Key 与缺失翻译检查（只读）。', { readOnlyHint: true }, (input: Parameters<LocalMcpServices['validateLocalizationFiles']>[0]) =>
    services.validateLocalizationFiles(input),
  );

  register('get_sync_status', '上次扫描/预览/回写结果、未解决冲突与 Git 状态（只读）。', { readOnlyHint: true }, (input: Parameters<LocalMcpServices['getSyncStatus']>[0]) =>
    services.getSyncStatus(input),
  );

  /* ------------------------------------------------------------------ writes */

  register(
    'push_project_changes',
    '把本地新增/更新推送到平台。必须传 confirm=true，且只能使用此前生成的、未过期的 preview 计划。',
    { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    (input: Parameters<LocalMcpServices['pushProjectChanges']>[0]) => services.pushProjectChanges(input),
  );

  register(
    'apply_translation_updates',
    '把平台已审核译文写回本地文件。必须二次确认（confirm=true）；会备份、原子写入、重新解析校验。',
    { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
    (input: Parameters<LocalMcpServices['applyTranslationUpdates']>[0]) => services.applyTranslationUpdates(input),
  );

  register(
    'resolve_sync_conflict',
    '以 KEEP_LOCAL / KEEP_REMOTE / MANUAL_MERGE / DEFER 解决冲突，必须显式选择。',
    { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    (input: Parameters<LocalMcpServices['resolveSyncConflict']>[0]) => services.resolveSyncConflict(input),
  );

  register(
    'report_apply_result',
    '把实际写回结果（文件、commit）回报平台，推进 Sync Baseline。',
    { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    (input: Parameters<LocalMcpServices['reportApplyResult']>[0]) => services.reportApplyResult(input),
  );

  register(
    'create_git_patch',
    '生成 patch/diff 文件（默认不 commit、不 push）。',
    { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    (input: { apply_plan_id?: string; output_path?: string; include_untracked?: boolean }) => services.createGitPatch(input),
  );

  /* ---------------------------------------------------------------- resources */

  server.registerResource(
    'local-project-config',
    'localehub://local/project-info',
    { title: 'Local project info', description: 'Workspace root, mappings and sync policy of the current repository', mimeType: 'application/json' },
    async (uri) => ({
      contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(await services.getLocalProjectInfo(), null, 2) }],
    }),
  );

  server.registerResource(
    'local-sync-status',
    'localehub://local/sync-status',
    { title: 'Local sync status', description: 'Last scan/preview/apply result and open conflicts', mimeType: 'application/json' },
    async (uri) => ({
      contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(await services.getSyncStatus({}), null, 2) }],
    }),
  );

  /* ------------------------------------------------------------------ prompts */

  server.registerPrompt(
    'sync-localization-project',
    { title: 'Sync localization project', description: '扫描 → 预览 → 确认 → 推送的完整流程' },
    () => ({
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text: [
              '请用 LocaleHub Local MCP 同步这个仓库的本地化文件：',
              '1. get_local_project_info 并概述工作区、映射与 Git 状态。',
              '2. scan_local_project。',
              '3. preview_sync，把 push / pull / unchanged / conflict / archive 分类清楚解释给我。',
              '4. 我确认后，用 push_project_changes(confirm=true) 推送；不要自动调用 translate 或审核接口。',
              '5. 推送完成后用 get_sync_status 汇报结果。',
            ].join('\n'),
          },
        },
      ],
    }),
  );

  server.registerPrompt(
    'review-localization-changes',
    { title: 'Review localization changes', description: '拉取平台变更并生成 dry-run diff' },
    () => ({
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text: [
              '请拉取平台已审核译文并给出回写预览：',
              '1. pull_platform_updates（只用 APPROVED）。',
              '2. preview_apply（dry-run）。',
              '3. 用表格列出 文件 / Key / 旧值 / 新值 / 审核状态，并说明会被阻止的条目及原因。',
              '4. 不要写文件，等我确认。',
            ].join('\n'),
          },
        },
      ],
    }),
  );

  server.registerPrompt(
    'fix-translation-issues',
    { title: 'Fix translation issues', description: '根据本地校验与平台 QA 修复问题并回写' },
    () => ({
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text: [
              '请修复本地化问题：',
              '1. validate_localization_files 并列出 ERROR/WARNING。',
              '2. 对占位符不一致/缺失翻译给出具体修复建议。',
              '3. 只对平台已审核的修复执行 preview_apply + apply_translation_updates(confirm=true)。',
            ].join('\n'),
          },
        },
      ],
    }),
  );

  server.registerPrompt(
    'prepare-localization-release',
    { title: 'Prepare localization release', description: '发布前校验清单' },
    () => ({
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text: [
              '发布前检查：',
              '1. get_sync_status，确认没有未解决的冲突或未应用的变更。',
              '2. validate_localization_files。',
              '3. preview_sync 并确认 summary.unchanged 覆盖全部 Key。',
              '4. 输出可提交的 Git 变更清单（默认不 commit）。',
            ].join('\n'),
          },
        },
      ],
    }),
  );

  return server;
}

export { ErrorCode, SERVER_NAME, SERVER_VERSION };
export type { ToolContext };
