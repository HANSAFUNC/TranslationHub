import { describe, expect, it } from 'vitest';

import { REMOTE_MCP_TOOL_SCOPES, REMOTE_MCP_TOOLS, remoteToolSchemas } from '../mcp-tools';
import { localeDisplayName, resolveLocaleTag } from '../locale';
import { ALL_MCP_SCOPES } from '../roles';

/**
 * The registry is what the discovery endpoint, the server and the docs all read, so a mistake here
 * is a mistake in three places at once — and the discovery endpoint describes the contract rather
 * than the running server, which means it cannot notice a tool the server never registered.
 */
describe('the Remote MCP tool registry', () => {
  it('has a schema for every tool', () => {
    for (const name of REMOTE_MCP_TOOLS) {
      expect(remoteToolSchemas[name], name).toBeTruthy();
    }
    expect(Object.keys(remoteToolSchemas).sort()).toEqual([...REMOTE_MCP_TOOLS].sort());
  });

  it('has no duplicate names', () => {
    expect(new Set(REMOTE_MCP_TOOLS).size).toBe(REMOTE_MCP_TOOLS.length);
  });

  it('names only real tools and real scopes in the scope map', () => {
    for (const [name, scopes] of Object.entries(REMOTE_MCP_TOOL_SCOPES)) {
      expect(REMOTE_MCP_TOOLS as readonly string[]).toContain(name);
      for (const scope of scopes ?? []) {
        expect(ALL_MCP_SCOPES as readonly string[]).toContain(scope);
      }
    }
  });

  it('gates the tools that write on the scope the spec requires', () => {
    // §2.2: pushing local changes up and writing platform changes down are separately granted.
    // These two are the whole point of that separation, so they are pinned here rather than left
    // to whoever edits the map next.
    expect(REMOTE_MCP_TOOL_SCOPES.mark_applied).toEqual(['translation.apply']);
    expect(REMOTE_MCP_TOOL_SCOPES.import_translations).toEqual([
      'repository.scan',
      'sync.preview',
      'sync.push',
    ]);
  });

  it('describes mark_applied as a write, with the version each item claims to have written', () => {
    const shape = remoteToolSchemas.mark_applied.shape;
    expect(Object.keys(shape).sort()).toEqual(['dry_run', 'git_branch', 'git_commit', 'items', 'project_id']);
    // The version is what makes the staleness check possible, so the field has to exist even
    // though the schema cannot require it without breaking a caller that legitimately omits it.
    expect(Object.keys(shape.items.element.shape).sort()).toEqual([
      'file_path',
      'key',
      'locale',
      'platform',
      'translation_version_id',
    ]);
  });
});

/**
 * Matching an incoming tag to what the project already has.
 *
 * The case that matters is the ordinary iOS layout: the repository holds `zh-Hans.lproj` while the
 * project's source locale is `zh-CN`. Before this, the platform created a second Chinese locale,
 * and because the code no longer equalled `sourceLocale` the import was not treated as source at
 * all — no source versions, no reference text, silently.
 */
describe('resolveLocaleTag', () => {
  it('prefers an exact match', () => {
    expect(resolveLocaleTag('zh-CN', ['zh-CN', 'en-US'])).toEqual({ code: 'zh-CN', reason: 'exact' });
  });

  it('treats a script and a region as the same Chinese', () => {
    expect(resolveLocaleTag('zh-Hans', ['zh-CN', 'en-US'])).toEqual({ code: 'zh-CN', reason: 'equivalent' });
    expect(resolveLocaleTag('zh-CN', ['zh-Hans', 'en-US'])).toEqual({ code: 'zh-Hans', reason: 'equivalent' });
    expect(resolveLocaleTag('zh-Hant', ['zh-TW'])).toEqual({ code: 'zh-TW', reason: 'equivalent' });
  });

  it('does not confuse Simplified with Traditional', () => {
    // The expensive mistake this rule exists to prevent.
    expect(resolveLocaleTag('zh-Hant', ['zh-CN'])).toEqual({ code: 'zh-Hant', reason: 'new' });
  });

  it('reads a bare language as the only locale that speaks it', () => {
    expect(resolveLocaleTag('ja', ['ja-JP', 'en-US'])).toEqual({ code: 'ja-JP', reason: 'equivalent' });
    expect(resolveLocaleTag('en', ['en-US'])).toEqual({ code: 'en-US', reason: 'equivalent' });
  });

  it('refuses to guess when more than one locale could be meant', () => {
    const resolution = resolveLocaleTag('zh', ['zh-CN', 'zh-TW']);
    expect(resolution.reason).toBe('ambiguous');
    expect(resolution.candidates).toEqual(['zh-CN', 'zh-TW']);
    expect(resolveLocaleTag('en', ['en-US', 'en-GB']).reason).toBe('ambiguous');
  });

  it('treats a language the project has never seen as new', () => {
    expect(resolveLocaleTag('fr-FR', ['en-US', 'ja-JP'])).toEqual({ code: 'fr-FR', reason: 'new' });
    expect(resolveLocaleTag('ko-KR', [])).toEqual({ code: 'ko-KR', reason: 'new' });
  });

  it('canonicalises the code it returns', () => {
    expect(resolveLocaleTag('fr-fr', []).code).toBe('fr-FR');
  });
});

describe('localeDisplayName', () => {
  it('names the languages a project is likely to grow', () => {
    expect(localeDisplayName('zh-CN')).toBe('中文（中国）');
    expect(localeDisplayName('zh-Hant')).toBe('中文（繁體）');
    expect(localeDisplayName('en-US')).toBe('English（United States）');
    expect(localeDisplayName('ja-JP')).toBe('日本語（日本）');
    expect(localeDisplayName('fr')).toBe('Français');
  });

  it('falls back to the tag rather than showing nothing', () => {
    expect(localeDisplayName('xx-QQ')).toBe('xx-QQ');
  });
});
