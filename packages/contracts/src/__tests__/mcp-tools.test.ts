import { describe, expect, it } from 'vitest';

import { REMOTE_MCP_TOOL_SCOPES, REMOTE_MCP_TOOLS, remoteToolSchemas } from '../mcp-tools';
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
