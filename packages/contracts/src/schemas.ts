import { z } from 'zod';
import { isValidLocaleTag } from './locale';
import { McpScope } from './roles';

export const localeTagSchema = z
  .string()
  .min(1)
  .max(64)
  .refine(isValidLocaleTag, { message: 'must be a valid BCP 47 language tag' });

export const platformSchema = z.enum(['web', 'ios', 'android', 'universal']);

export const formatIdSchema = z.enum([
  'json',
  'yaml',
  'po',
  'xliff',
  'ios-strings',
  'ios-stringsdict',
  'xcstrings',
  'android-xml',
]);

export const reviewStatusSchema = z.enum(['DRAFT', 'PENDING_REVIEW', 'APPROVED', 'REJECTED', 'STALE']);
export const syncDirectionSchema = z.enum(['bidirectional', 'push', 'pull']);

/* ---------------------------------- local config (.localehub/config.yaml) --------------------------------- */

export const fileMappingSchema = z.object({
  id: z.string().min(1),
  platform: platformSchema,
  locale: localeTagSchema.optional(),
  localeFromPath: z.boolean().optional(),
  format: formatIdSchema,
  source: z.boolean().optional(),
  paths: z.array(z.string().min(1)).min(1),
  keyMode: z.enum(['nested', 'flat']).optional(),
  namespaceFromPath: z.boolean().optional(),
  preservePlatformMetadata: z.boolean().optional(),
});

export const localConfigSchema = z.object({
  version: z.literal(1),
  project: z.object({
    id: z.string().min(1),
    name: z.string().optional(),
    sourceLocale: localeTagSchema,
    platforms: z.array(platformSchema).optional(),
  }),
  localehub: z.object({
    apiUrl: z.string().url(),
    tokenEnv: z.string().min(1).default('LOCALEHUB_TOKEN'),
  }),
  workspace: z.object({
    root: z.string().default('.'),
    allowRead: z.array(z.string()).default([]),
    allowWrite: z.array(z.string()).default([]),
    denyRead: z.array(z.string()).default([]),
    denyWrite: z.array(z.string()).default([]),
  }),
  sync: z
    .object({
      defaultDirection: z.enum(['bidirectional', 'push', 'pull']).default('bidirectional'),
      deletePolicy: z.enum(['archive', 'ignore', 'require_confirmation']).default('archive'),
      applyPolicy: z.enum(['approved_only', 'allow_draft_with_permission']).default('approved_only'),
      conflictPolicy: z.enum(['manual', 'prefer_local', 'prefer_remote']).default('manual'),
      writeMode: z.enum(['dry_run_by_default', 'apply_by_default']).default('dry_run_by_default'),
      preserveUnknownFields: z.boolean().default(true),
      createBackup: z.boolean().default(true),
      maxFilesPerBatch: z.number().int().positive().max(5000).default(500),
    })
    .default({}),
  files: z.array(fileMappingSchema).min(1),
  ignore: z
    .object({ keys: z.array(z.string()).default([]), paths: z.array(z.string()).default([]) })
    .default({ keys: [], paths: [] }),
});

export type LocalConfig = z.infer<typeof localConfigSchema>;
export type FileMappingConfig = z.infer<typeof fileMappingSchema>;

/* ---------------------------------- API / MCP payload schemas --------------------------------- */

export const scanEntrySchema = z.object({
  key: z.string().min(1).max(512),
  namespace: z.string().max(255).default(''),
  locale: localeTagSchema,
  value: z.string(),
  isSource: z.boolean(),
  contentHash: z.string().length(64),
  fileId: z.string().min(1),
  filePath: z.string().min(1),
  description: z.string().optional(),
  context: z.record(z.unknown()).optional(),
  placeholders: z.array(z.object({ name: z.string(), type: z.string().optional(), format: z.string().optional() })).optional(),
  platformMetadata: z.record(z.unknown()).optional(),
  deleted: z.boolean().optional(),
});

export const scanBatchSchema = z.object({
  projectId: z.string().min(1),
  repositoryConnectionId: z.string().min(1).optional(),
  scanId: z.string().min(1),
  client: z
    .object({
      name: z.string(),
      version: z.string(),
      gitBranch: z.string().optional(),
      gitCommit: z.string().optional(),
    })
    .optional(),
  files: z
    .array(
      z.object({
        fileId: z.string(),
        filePath: z.string(),
        locale: localeTagSchema,
        platform: platformSchema,
        format: formatIdSchema,
        fileHash: z.string(),
        entryCount: z.number().int(),
        parseError: z.string().optional(),
      }),
    )
    .default([]),
  entries: z.array(scanEntrySchema).max(20000),
});

export type ScanBatchPayload = z.infer<typeof scanBatchSchema>;

export const syncPreviewSchema = z.object({
  projectId: z.string().min(1),
  repositoryConnectionId: z.string().min(1),
  scanId: z.string().min(1),
  direction: syncDirectionSchema.default('bidirectional'),
  baseRevision: z.number().int().nonnegative().optional(),
  includeDeletes: z.boolean().default(false),
  includeDrafts: z.boolean().default(false),
  locales: z.array(localeTagSchema).optional(),
});

export const syncPushSchema = z.object({
  syncPlanId: z.string().min(1),
  planHash: z.string().min(1),
  confirmed: z.literal(true),
  client: z
    .object({
      name: z.string(),
      version: z.string(),
      gitBranch: z.string().optional(),
      gitCommit: z.string().optional(),
    })
    .optional(),
});

export const applyReportSchema = z.object({
  syncSessionId: z.string().min(1),
  applyPlanId: z.string().min(1),
  client: z.object({ name: z.string(), version: z.string(), gitBranch: z.string().optional(), gitCommit: z.string().optional() }),
  status: z.enum(['SUCCEEDED', 'PARTIAL', 'FAILED']),
  files: z.array(z.object({ filePath: z.string(), backupPath: z.string().nullable().optional(), contentHash: z.string() })),
  items: z.array(
    z.object({
      key: z.string(),
      locale: localeTagSchema,
      namespace: z.string().default(''),
      platform: platformSchema,
      filePath: z.string(),
      applied: z.boolean(),
      previousValue: z.string().nullable(),
      newValue: z.string(),
      translationVersionId: z.string().nullable(),
      errorCode: z.string().optional(),
      errorMessage: z.string().optional(),
    }),
  ),
  gitCommit: z.string().nullable().optional(),
  gitDiffStat: z.string().nullable().optional(),
});

export const resolveConflictSchema = z.object({
  resolution: z.enum(['KEEP_LOCAL', 'KEEP_REMOTE', 'MANUAL_MERGE', 'DEFER']),
  value: z.string().optional(),
  note: z.string().optional(),
});

export const mcpScopeSchema = z.enum(Object.values(McpScope) as [string, ...string[]]);

export const createMcpTokenSchema = z.object({
  name: z.string().min(1).max(120),
  scopes: z.array(mcpScopeSchema).min(1),
  projectIds: z.array(z.string()).default([]),
  expiresInDays: z.number().int().positive().max(365).default(30),
  repositoryConnectionId: z.string().optional(),
});

export const translationDraftSchema = z.object({
  value: z.string(),
  expectedRevision: z.number().int().nonnegative().optional(),
  comment: z.string().max(2000).optional(),
  expectedContentHash: z.string().optional(),
});

export const reviewActionSchema = z.object({
  action: z.enum(['APPROVE', 'REJECT', 'REQUEST_CHANGES']),
  comment: z.string().max(2000).optional(),
});
