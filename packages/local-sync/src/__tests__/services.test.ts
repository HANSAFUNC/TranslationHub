import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { LocalSyncServices } from '../services';

/**
 * Configuration resolution for the local engine.
 *
 * `LOCALEHUB_API_URL` is documented as overriding `.localehub/config.yaml`. It used to be applied
 * by the MCP entry point on its own copy of `LoadedConfig`, which the services never read — they
 * load their own — so the override was silently dropped and every caller talked to the config
 * file's address regardless. These tests pin it where it now lives: `config()`.
 */

function workspaceWithConfig(): string {
  const root = mkdtempSync(join(tmpdir(), 'localehub-local-'));
  mkdirSync(join(root, '.localehub'), { recursive: true });
  writeFileSync(
    join(root, '.localehub', 'config.yaml'),
    [
      'version: 1',
      'project:',
      '  id: "00000000-0000-0000-0000-000000000001"',
      '  name: "Fixture"',
      '  sourceLocale: "en-US"',
      '  platforms: [web]',
      'localehub:',
      '  apiUrl: "http://config-file.invalid/api/v1"',
      '  tokenEnv: "LOCALEHUB_TOKEN"',
      'workspace:',
      '  root: "."',
      'files:',
      '  - id: "web-en"',
      '    platform: "web"',
      '    locale: "en-US"',
      '    format: "json"',
      '    source: true',
      '    paths: ["src/en-US/**/*.json"]',
    ].join('\n'),
    'utf8',
  );
  return root;
}

describe('LOCALEHUB_API_URL', () => {
  it('overrides the address in .localehub/config.yaml', () => {
    const services = new LocalSyncServices({
      cwd: workspaceWithConfig(),
      env: { LOCALEHUB_TOKEN: 't', LOCALEHUB_API_URL: 'http://env-wins/api/v1' },
    });
    expect(services.config().config.localehub.apiUrl).toBe('http://env-wins/api/v1');
  });

  it('leaves the config file address in place when unset', () => {
    const services = new LocalSyncServices({
      cwd: workspaceWithConfig(),
      env: { LOCALEHUB_TOKEN: 't' },
    });
    expect(services.config().config.localehub.apiUrl).toBe('http://config-file.invalid/api/v1');
  });
});
