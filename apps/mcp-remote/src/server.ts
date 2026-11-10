import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { PrismaClient } from '@localehub/database';
import {
  AiService,
  SyncService,
  assertPlaceholdersPreserved,
  emitProjectEvent,
  upsertTranslation,
} from '@localehub/domain';
import {
  ErrorCode,
  LocaleHubError,
  Role,
  remoteToolSchemas,
  type RemoteMcpTool,
} from '@localehub/contracts';
import { assertRole, type ActorContext } from '@localehub/permissions';
import { TenantPrisma } from '@localehub/database';

/**
 * Remote MCP server (Streamable HTTP).
 *
 * It exposes *platform* capabilities only. There is deliberately no local file tool here: the
 * platform can never read or write a developer machine (spec §6.1, §0.3). Authorization reuses
 * the exact same role/scope logic as the REST API.
 */
/**
 * MCP requires `structuredContent` to be a JSON object, so arrays are wrapped and any Date /
 * undefined values are normalised through a JSON round-trip before being returned.
 */
function toStructuredContent(result: unknown): Record<string, unknown> {
  const normalised = JSON.parse(JSON.stringify(result ?? null)) as unknown;
  if (normalised && typeof normalised === 'object' && !Array.isArray(normalised)) {
    return normalised as Record<string, unknown>;
  }
  return { items: normalised };
}

export function buildRemoteMcpServer(actor: ActorContext, prisma: PrismaClient, tenant: TenantPrisma): McpServer {
  const server = new McpServer(
    { name: 'localehub-remote', version: '0.1.0' },
    {
      instructions:
        'LocaleHub Remote MCP：只提供平台侧数据与业务工具（项目、Key、译文、术语、翻译记忆、QA、审核、同步状态）。' +
        '它无法访问任何开发者本地文件系统。AI 生成的译文一律为草稿，审核与发布必须由具备权限的人类用户完成。',
      capabilities: { tools: {}, resources: {}, prompts: {} },
    },
  );

  const sync = new SyncService(prisma, tenant);
  const ai = new AiService(prisma, tenant);

  const registerTool = server.registerTool.bind(server) as unknown as (
    name: string,
    config: { description: string; inputSchema: Record<string, unknown>; annotations?: Record<string, unknown> },
    handler: (input: unknown) => Promise<unknown>,
  ) => void;

  /**
   * Tools that change platform state. Declaring these as read-only would tell an MCP client the
   * call cannot modify anything — some clients use that to skip asking the user — so the four
   * that write drafts, review decisions and submission status must say so.
   */
  const WRITE_TOOLS = new Set<string>(['translate_entries', 'review_translation_entries', 'update_translation_draft', 'submit_review']);

  const define = <K extends RemoteMcpTool>(name: K, description: string, handler: (input: never) => Promise<unknown>) => {
    const schema = remoteToolSchemas[name] as unknown as { shape?: Record<string, unknown>; _def?: { schema?: { shape?: Record<string, unknown> } } };
    // None of these destroy anything (versions are immutable, review decisions are reversible), so
    // `destructiveHint` stays false; they are simply not read-only.
    const annotations = WRITE_TOOLS.has(name)
      ? { readOnlyHint: false, destructiveHint: false }
      : { readOnlyHint: true };
    registerTool(
      name,
      { description, inputSchema: schema.shape ?? schema._def?.schema?.shape ?? {}, annotations },
      async (input: unknown) => {
        try {
          const result = await handler(input as never);
          return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }], structuredContent: toStructuredContent(result) };
        } catch (error) {
          const err = error instanceof LocaleHubError ? error : LocaleHubError.from(error);
          return {
            isError: true,
            content: [{ type: 'text' as const, text: JSON.stringify({ error: { code: err.code, message: err.message } }) }],
          };
        }
      },
    );
  };

  /* ------------------------------------------------------------------- projects */

  define('list_projects', '列出当前 token 可访问的项目', async () =>
    tenant.withOrganization(actor.organizationId, async (tx) => {
      const projects = await tx.project.findMany({
        where: actor.boundProjectIds?.length ? { id: { in: actor.boundProjectIds } } : {},
        orderBy: { name: 'asc' },
        include: { _count: { select: { keys: true, entries: true, locales: true } } },
      });
      return projects.map((project) => ({
        id: project.id,
        name: project.name,
        slug: project.slug,
        sourceLocale: project.sourceLocale,
        revision: project.revision,
        counts: project._count,
      }));
    }),
  );

  define('get_project', '读取项目详情', async (input: { project_id: string }) => {
    assertRole(actor, input.project_id, Role.READONLY);
    return tenant.withOrganization(actor.organizationId, (tx) =>
      tx.project.findUniqueOrThrow({ where: { id: input.project_id }, include: { locales: true, platforms: true } }),
    );
  });

  define('list_project_locales', '读取项目语言列表', async (input: { project_id: string }) => {
    assertRole(actor, input.project_id, Role.READONLY);
    return tenant.withOrganization(actor.organizationId, (tx) =>
      tx.locale.findMany({ where: { projectId: input.project_id }, orderBy: { code: 'asc' } }),
    );
  });

  /* --------------------------------------------------------------- translations */

  define('search_translation_keys', '检索翻译 Key', async (input: { project_id: string; query?: string; locale?: string; status?: string; platform?: string; limit?: number; cursor?: string }) => {
    assertRole(actor, input.project_id, Role.READONLY);
    return tenant.withOrganization(actor.organizationId, async (tx) => {
      const rows = await tx.translationEntry.findMany({
        where: {
          projectId: input.project_id,
          ...(input.locale ? { localeCode: input.locale } : {}),
          ...(input.status ? { status: input.status as never } : {}),
          key: {
            archivedAt: null,
            ...(input.platform ? { platform: input.platform as never } : {}),
            ...(input.query ? { key: { contains: input.query, mode: 'insensitive' } } : {}),
          },
        },
        include: { key: { include: { namespace: true, sourceVersions: { orderBy: { version: 'desc' }, take: 1 } } } },
        take: Math.min(input.limit ?? 50, 200),
        skip: input.cursor ? 1 : 0,
        ...(input.cursor ? { cursor: { id: input.cursor } } : {}),
        orderBy: { id: 'asc' },
      });
      return rows.map((entry) => ({
        entryId: entry.id,
        key: entry.key.key,
        namespace: entry.key.namespace.name,
        platform: entry.key.platform,
        locale: entry.localeCode,
        value: entry.value,
        status: entry.status,
        source: entry.key.sourceVersions[0]?.value ?? null,
        revision: entry.revision,
      }));
    });
  });

  define('get_translation_entry', '读取单条翻译条目（含版本历史与 QA 问题）', async (input: { project_id: string; key: string; locale: string }) => {
    assertRole(actor, input.project_id, Role.READONLY);
    return tenant.withOrganization(actor.organizationId, async (tx) => {
      const entry = await tx.translationEntry.findFirst({
        where: { projectId: input.project_id, localeCode: input.locale, key: { key: input.key } },
        include: {
          key: { include: { namespace: true, sourceVersions: { orderBy: { version: 'desc' }, take: 5 } } },
          versions: { orderBy: { version: 'desc' }, take: 10 },
        },
      });
      if (!entry) throw new LocaleHubError(ErrorCode.NOT_FOUND, `No entry for ${input.key} in ${input.locale}`, 404);
      const qaIssues = await tx.qaIssue.findMany({ where: { entryId: entry.id, status: 'OPEN' } });
      return { entry, qaIssues };
    });
  });

  define('get_glossary', '读取术语库', async (input: { project_id: string; locale?: string }) => {
    assertRole(actor, input.project_id, Role.READONLY);
    return tenant.withOrganization(actor.organizationId, (tx) =>
      tx.glossaryTerm.findMany({ where: { organizationId: actor.organizationId, OR: [{ projectId: input.project_id }, { projectId: null }] } }),
    );
  });

  define('search_translation_memory', '检索翻译记忆', async (input: { project_id: string; query: string; locale?: string; limit?: number }) => {
    assertRole(actor, input.project_id, Role.READONLY);
    return tenant.withOrganization(actor.organizationId, (tx) =>
      tx.translationMemoryEntry.findMany({
        where: {
          organizationId: actor.organizationId,
          ...(input.locale ? { targetLocale: input.locale } : {}),
          sourceText: { contains: input.query, mode: 'insensitive' },
        },
        take: Math.min(input.limit ?? 10, 50),
      }),
    );
  });

  /* ------------------------------------------------------------------------ AI */

  define('translate_entries', '调用 AI 生成草稿译文（永远写为 DRAFT，不能自动通过审核）', async (input: { project_id: string; entry_ids: string[]; target_locales: string[]; provider?: string; write_drafts: boolean }) => {
    assertRole(actor, input.project_id, Role.PRODUCT_MANAGER);
    return ai.draftTranslations(actor, input.project_id, {
      entryIds: input.entry_ids,
      targetLocales: input.target_locales,
      provider: input.provider,
      writeDrafts: input.write_drafts,
    });
  });

  define('review_translation_entries', '提交审核决定（需要 REVIEWER 权限）', async (input: { project_id: string; entry_ids: string[]; locales?: string[]; decision: 'APPROVE' | 'REJECT'; comment?: string }) => {
    assertRole(actor, input.project_id, Role.REVIEWER);
    return tenant.withOrganization(actor.organizationId, async (tx) => {
      const results: { entryId: string; status: string }[] = [];
      for (const entryId of input.entry_ids) {
        const entry = await tx.translationEntry.findUnique({ where: { id: entryId }, include: { key: true } });
        if (!entry || entry.projectId !== input.project_id) continue;
        if (input.locales?.length && !input.locales.includes(entry.localeCode)) continue;
        if (entry.status === 'STALE' && input.decision === 'APPROVE') {
          throw new LocaleHubError(ErrorCode.STALE_TRANSLATION, `${entry.key.key} (${entry.localeCode}) is stale; re-translate before approving`, 409);
        }
        const status = input.decision === 'APPROVE' ? 'APPROVED' : 'REJECTED';
        await tx.translationEntry.update({ where: { id: entryId }, data: { status: status as never, revision: entry.revision + 1 } });
        await emitProjectEvent(tx, {
          organizationId: actor.organizationId,
          projectId: input.project_id,
          eventType: input.decision === 'APPROVE' ? 'TRANSLATION_APPROVED' : 'TRANSLATION_REJECTED',
          resourceType: 'translation_entry',
          resourceId: entryId,
          payload: { entryId, key: entry.key.key, locale: entry.localeCode, platform: entry.key.platform, viaMcp: true, comment: input.comment ?? null },
          actorId: actor.userId,
          actorType: 'mcp',
        });
        results.push({ entryId, status });
      }
      return { results };
    });
  });

  define('get_qa_issues', '读取 QA 问题', async (input: { project_id: string; locale?: string; severity?: string; limit?: number }) => {
    assertRole(actor, input.project_id, Role.READONLY);
    return tenant.withOrganization(actor.organizationId, (tx) =>
      tx.qaIssue.findMany({
        where: {
          projectId: input.project_id,
          status: 'OPEN',
          ...(input.locale ? { localeCode: input.locale } : {}),
          ...(input.severity ? { severity: input.severity as never } : {}),
        },
        take: Math.min(input.limit ?? 50, 200),
      }),
    );
  });

  define('update_translation_draft', '更新译文草稿（新版本，不覆盖历史）', async (input: { project_id: string; key: string; locale: string; value: string; expected_revision?: number }) => {
    assertRole(actor, input.project_id, Role.TRANSLATOR);
    return tenant.withOrganization(actor.organizationId, async (tx) => {
      const entry = await tx.translationEntry.findFirst({
        where: { projectId: input.project_id, localeCode: input.locale, key: { key: input.key } },
        include: { key: { include: { sourceVersions: { orderBy: { version: 'desc' }, take: 1 } } } },
      });
      if (!entry) throw new LocaleHubError(ErrorCode.NOT_FOUND, `No entry for ${input.key} in ${input.locale}`, 404);
      if (input.expected_revision !== undefined && input.expected_revision !== entry.revision) {
        throw new LocaleHubError(ErrorCode.CONFLICT, `Entry revision mismatch (expected ${input.expected_revision}, current ${entry.revision})`, 409);
      }
      assertPlaceholdersPreserved(entry.key.sourceVersions[0]?.value ?? '', input.value, entry.key.key, entry.localeCode);
      const result = await upsertTranslation(tx, {
        organizationId: actor.organizationId,
        projectId: input.project_id,
        keyId: entry.keyId,
        localeId: entry.localeId,
        localeCode: entry.localeCode,
        value: input.value,
        status: 'DRAFT',
        basedOnSourceVersionId: entry.key.sourceVersions[0]?.id ?? null,
        authorId: actor.userId,
        authorType: 'mcp',
      });
      return { entryId: entry.id, translationVersionId: result.translationVersionId, changed: result.changed };
    });
  });

  define('submit_review', '提交审核', async (input: { project_id: string; entry_ids: string[]; locales?: string[]; comment?: string }) => {
    assertRole(actor, input.project_id, Role.TRANSLATOR);
    return tenant.withOrganization(actor.organizationId, async (tx) => {
      let submitted = 0;
      for (const entryId of input.entry_ids) {
        const entry = await tx.translationEntry.findUnique({ where: { id: entryId }, include: { key: true } });
        if (!entry || entry.projectId !== input.project_id) continue;
        if (input.locales?.length && !input.locales.includes(entry.localeCode)) continue;
        await tx.translationEntry.update({ where: { id: entryId }, data: { status: 'PENDING_REVIEW' } });
        await tx.reviewTask.create({
          data: {
            organizationId: actor.organizationId,
            projectId: input.project_id,
            entryId,
            localeCode: entry.localeCode,
            status: 'PENDING_REVIEW',
            submittedById: actor.userId,
          },
        });
        await emitProjectEvent(tx, {
          organizationId: actor.organizationId,
          projectId: input.project_id,
          eventType: 'TRANSLATION_SUBMITTED',
          resourceType: 'translation_entry',
          resourceId: entryId,
          payload: { entryId, key: entry.key.key, locale: entry.localeCode, comment: input.comment ?? null },
          actorId: actor.userId,
          actorType: 'mcp',
        });
        submitted += 1;
      }
      return { submitted };
    });
  });

  /* ------------------------------------------------------------------- sync view */

  define('get_project_sync_status', '读取仓库同步状态（只读；不触碰开发者机器）', async (input: { project_id: string }) => {
    assertRole(actor, input.project_id, Role.READONLY);
    return sync.syncStatus(input.project_id, actor);
  });

  define('get_pending_platform_changes', '读取待拉取的平台变更（默认 APPROVED）', async (input: { project_id: string; locale?: string; status?: string; since_revision?: number; limit?: number }) => {
    assertRole(actor, input.project_id, Role.READONLY);
    return sync.getChanges(
      {
        projectId: input.project_id,
        locales: input.locale ? [input.locale] : undefined,
        statuses: [input.status ?? 'APPROVED'] as never,
        sinceRevision: input.since_revision,
        limit: input.limit ?? 100,
      },
      actor,
    );
  });

  define('validate_release', '发布前校验（缺译、占位符、过期、未解决冲突）', async (input: { project_id: string; locales?: string[]; fail_on?: string }) => {
    assertRole(actor, input.project_id, Role.READONLY);
    return sync.validateForRelease(input.project_id, actor);
  });

  /* ------------------------------------------------------------------ resources */

  for (const resource of [
    { name: 'project', uri: 'localehub://projects/{projectId}', template: true },
    { name: 'locales', uri: 'localehub://projects/{projectId}/locales', template: true },
  ] as const) {
    void resource;
  }

  server.registerResource(
    'qa-rules',
    'localehub://qa-rules',
    { title: 'QA rules', description: 'Built-in localization QA rule set', mimeType: 'application/json' },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: 'application/json',
          text: JSON.stringify(
            [
              { code: 'EMPTY_TRANSLATION', severity: 'ERROR' },
              { code: 'PLACEHOLDER_MISMATCH', severity: 'ERROR' },
              { code: 'MISSING_TRANSLATION', severity: 'WARNING' },
              { code: 'STALE_TRANSLATION', severity: 'WARNING' },
              { code: 'HTML_TAG_MISMATCH', severity: 'WARNING' },
              { code: 'PUNCTUATION_MISMATCH', severity: 'INFO' },
              { code: 'GLOSSARY_TERM_MISSING', severity: 'WARNING' },
            ],
            null,
            2,
          ),
        },
      ],
    }),
  );

  /* -------------------------------------------------------------------- prompts */

  server.registerPrompt('review-localization-changes', { title: 'Review localization changes', description: '审核平台侧译文变更' }, () => ({
    messages: [
      {
        role: 'user',
        content: {
          type: 'text',
          text: '请用 Remote MCP 检查本项目待审核与待拉取的变更：search_translation_keys(status=PENDING_REVIEW) → get_translation_entry → get_qa_issues，给出逐条审核建议。注意：你只能提出建议，最终审核必须由人类审核人执行。',
        },
      },
    ],
  }));

  server.registerPrompt('fix-translation-issues', { title: 'Fix translation issues', description: '根据 QA 问题给出修复草稿' }, () => ({
    messages: [
      {
        role: 'user',
        content: {
          type: 'text',
          text: '请读取 get_qa_issues，对每个问题给出修复后的译文，并用 update_translation_draft 写入草稿（不要提交审核，也不要尝试批准）。',
        },
      },
    ],
  }));

  return server;
}
