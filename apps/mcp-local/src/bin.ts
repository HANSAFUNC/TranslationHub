#!/usr/bin/env node
import { resolve } from 'node:path';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadLocalConfig } from '@localehub/workspace';
import { LocalMcpServices } from './services';
import { buildLocalMcpServer, SERVER_NAME, SERVER_VERSION } from './server';

/**
 * LocaleHub Local MCP entry point.
 *
 * Transport: stdio only. The process runs on the developer machine, inside (or pointed at) the
 * repository, and can never be reached over the network (spec §6.1).
 */
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    process.stdout.write(`LocaleHub Local MCP v${SERVER_VERSION}

Usage: localehub-mcp-local --stdio [--workspace <path>]

Environment:
  LOCALEHUB_WORKSPACE    repository root (defaults to $PWD)
  LOCALEHUB_API_URL      platform API base url (overrides .localehub/config.yaml)
  LOCALEHUB_TOKEN        platform token (name is configurable via localehub.tokenEnv)

The server speaks MCP over stdio. It never opens a network port.
`);
    return;
  }

  const workspaceIndex = args.indexOf('--workspace');
  const workspace = resolve(
    workspaceIndex >= 0 && args[workspaceIndex + 1]
      ? args[workspaceIndex + 1]!
      : process.env.LOCALEHUB_WORKSPACE ?? process.cwd(),
  );
  // Never write to stdout except MCP frames: all logging goes to stderr.
  console.error(`[${SERVER_NAME}] starting in ${workspace}`);

  const loaded = loadLocalConfig(workspace);
  if (process.env.LOCALEHUB_API_URL) {
    loaded.config.localehub.apiUrl = process.env.LOCALEHUB_API_URL;
  }
  const services = new LocalMcpServices({ cwd: workspace, env: process.env });
  const server = buildLocalMcpServer(services);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`[${SERVER_NAME}] ready (project ${loaded.config.project.id})`);
}

main().catch((error) => {
  console.error(`[${SERVER_NAME}] failed to start:`, error instanceof Error ? error.message : error);
  process.exit(1);
});
