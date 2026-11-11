import { stringify as toYaml } from 'yaml';
import { DEFAULT_MCP_SCOPES, type PlatformName } from '@localehub/contracts';

/**
 * The `.localehub/config.yaml` template.
 *
 * Shared by `localehub init` and the MCP bootstrap tool, because both leave the same file behind
 * and a second copy of this shape is how the two would disagree about what a valid workspace
 * looks like. The workspace package owns it because it owns the config format.
 */

export interface LocalConfigTemplateInput {
  projectId: string;
  projectName?: string;
  sourceLocale: string;
  /** Target locales; the source is added automatically and duplicates are dropped. */
  locales: string[];
  platforms?: PlatformName[];
  apiUrl: string;
  tokenEnv?: string;
  /**
   * Where the language files live. Defaults match the layout most repositories use, and the
   * caller can narrow them; `allowWrite` follows the same paths, because a mapping that cannot be
   * written back is a mapping that can never be applied.
   */
  localesDir?: string;
}

export interface LocalConfigTemplateResult {
  /** The YAML text, ready to write to `.localehub/config.yaml`. */
  yaml: string;
  /** The mapping ids, so a caller can describe what it produced. */
  fileSetIds: string[];
}

export function renderLocalConfig(input: LocalConfigTemplateInput): LocalConfigTemplateResult {
  const sourceLocale = input.sourceLocale;
  const targets = [...new Set(input.locales.filter((locale) => locale && locale !== sourceLocale))];
  const platforms = [...new Set(input.platforms ?? ['web'])];
  const dir = input.localesDir ?? 'locales';
  const extension = 'json';

  const files = [
    {
      id: `${platforms[0]}-source`,
      platform: platforms[0],
      locale: sourceLocale,
      format: extension,
      source: true,
      paths: [`${dir}/${sourceLocale}/**/*.${extension}`],
      keyMode: 'nested',
      namespaceFromPath: true,
    },
    ...targets.map((locale) => ({
      id: `${platforms[0]}-${locale.toLowerCase()}`,
      platform: platforms[0],
      locale,
      format: extension,
      source: false,
      paths: [`${dir}/${locale}/**/*.${extension}`],
      keyMode: 'nested',
      namespaceFromPath: true,
    })),
  ];

  const config = {
    version: 1,
    project: {
      id: input.projectId,
      ...(input.projectName ? { name: input.projectName } : {}),
      sourceLocale,
      platforms,
    },
    localehub: {
      apiUrl: input.apiUrl,
      // A variable reference, never a literal: this file is committed.
      tokenEnv: input.tokenEnv ?? 'LOCALEHUB_TOKEN',
    },
    workspace: {
      root: '.',
      allowRead: ['src/**', 'app/**', `${dir}/**`],
      // Write access is limited to the language resources. Everything else in the repository stays
      // out of reach of the sync engine, which is the whole point of the allowlist.
      allowWrite: [`${dir}/**`],
      denyRead: ['.env*', '**/secrets/**', 'node_modules/**'],
      denyWrite: ['.env*', '**/secrets/**', '**/*.generated.*'],
    },
    sync: {
      defaultDirection: 'bidirectional',
      deletePolicy: 'archive',
      applyPolicy: 'approved_only',
      conflictPolicy: 'manual',
      // Writes stay off until somebody asks for them, even on a freshly initialised repository.
      writeMode: 'dry_run_by_default',
      preserveUnknownFields: true,
      createBackup: true,
      maxFilesPerBatch: 500,
    },
    files,
    ignore: { keys: ['debug.*'], paths: ['**/*.generated.*'] },
  };

  return {
    yaml: `# LocaleHub repository configuration — see docs/MCP.md\n${toYaml(config)}`,
    fileSetIds: files.map((file) => file.id),
  };
}

/**
 * The scopes a repository needs for the flow the config describes.
 *
 * Exported so the bootstrap tool can tell the caller which token to sign instead of leaving them
 * to guess from a list of twelve.
 */
export function recommendedScopes(): string[] {
  return [...DEFAULT_MCP_SCOPES];
}
