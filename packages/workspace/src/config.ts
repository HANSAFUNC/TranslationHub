import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { ErrorCode, LocaleHubError, localConfigSchema, type LocalConfig } from '@localehub/contracts';
import { validateLocalConfig, type ConfigValidationResult } from './index';

export const CONFIG_RELATIVE_PATH = '.localehub/config.yaml';

export interface LoadedConfig {
  config: LocalConfig;
  configPath: string;
  root: string;
  validation: ConfigValidationResult;
  /** environment variable that carries the platform token (never the token itself) */
  tokenEnv: string;
}

export function loadLocalConfig(startDir: string = process.cwd()): LoadedConfig {
  const configPath = findConfigFile(startDir);
  if (!configPath) {
    throw new LocaleHubError(
      ErrorCode.CONFIG_INVALID,
      `No ${CONFIG_RELATIVE_PATH} found in ${startDir} or any parent directory. Run \`localehub init\` first.`,
      400,
    );
  }
  const raw = readFileSync(configPath, 'utf8');
  let parsed: unknown;
  try {
    parsed = parseYaml(raw);
  } catch (error) {
    throw new LocaleHubError(ErrorCode.CONFIG_INVALID, `Invalid YAML in ${configPath}: ${(error as Error).message}`, 400);
  }
  const result = localConfigSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues.map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`).join('; ');
    throw new LocaleHubError(ErrorCode.CONFIG_INVALID, `Invalid ${CONFIG_RELATIVE_PATH}: ${issues}`, 400);
  }
  const config = result.data;
  const validation = validateLocalConfig(config);
  if (validation.errors.length) {
    throw new LocaleHubError(
      ErrorCode.CONFIG_INVALID,
      `Configuration errors: ${validation.errors.map((e) => e.message).join('; ')}`,
      400,
      validation.errors,
    );
  }
  const root = config.workspace.root && config.workspace.root !== '.'
    ? resolve(configPath, '..', '..', config.workspace.root)
    : resolve(configPath, '..', '..');

  assertNoTokenInConfig(raw, configPath);

  return { config, configPath, root, validation, tokenEnv: config.localehub.tokenEnv };
}

export function findConfigFile(startDir: string): string | null {
  let current = resolve(startDir);
  for (let depth = 0; depth < 10; depth += 1) {
    const candidate = resolve(current, CONFIG_RELATIVE_PATH);
    if (existsSync(candidate)) return candidate;
    const parent = resolve(current, '..');
    if (parent === current) break;
    current = parent;
  }
  return null;
}

/**
 * Spec §4.2: "Token 不能出现在 YAML 示例、Git、日志或错误栈中".
 * A literal token in the config file is a configuration error, not a warning.
 */
function assertNoTokenInConfig(raw: string, configPath: string): void {
  const suspicious = /(^|\s)(token|apiKey|api_key|secret|password)\s*:\s*(?!""|''|\s*$)([^\s#]+)/im.exec(raw);
  if (suspicious) {
    throw new LocaleHubError(
      ErrorCode.CONFIG_INVALID,
      `${configPath} appears to contain an inline secret ("${suspicious[2]}"). Use tokenEnv and export the token as an environment variable instead.`,
      400,
    );
  }
}

export function resolveToken(config: LocalConfig, env: NodeJS.ProcessEnv = process.env): string {
  const name = config.localehub.tokenEnv;
  const token = env[name];
  if (!token) {
    throw new LocaleHubError(
      ErrorCode.INVALID_TOKEN,
      `Environment variable ${name} is empty. Export your LocaleHub token before running the CLI.`,
      401,
      { envVar: name },
    );
  }
  return token;
}
