import { Controller, Get } from '@nestjs/common';
import { claudeCliCommand, formatMcpClientConfig, mcpClientConfig, mcpToolJsonSchemas } from '@localehub/contracts';
import { Public } from '../../common/auth';
import { LOCAL_TOOL_DESCRIPTIONS, REMOTE_TOOL_DESCRIPTIONS } from './tool-descriptions';

/**
 * Machine readable MCP tool discovery.
 *
 * The Remote MCP binary serves the same registry over the real MCP transport; this endpoint
 * exists so the web UI, the CLI and the docs can render tool schemas without speaking MCP.
 * It contains no secrets and grants no local filesystem capability.
 */
@Controller('mcp')
export class McpController {
  @Public()
  @Get('tools')
  tools() {
    const schemas = mcpToolJsonSchemas();
    const remoteUrl = process.env.MCP_PUBLIC_URL || 'http://localhost:3003/mcp';
    // The Local MCP runs on a developer machine, so it needs an address that resolves from there
    // — the deployment's own API URL, not the browser's origin.
    const apiUrl = process.env.API_BASE_URL || 'http://localhost:3001/api/v1';
    return {
      local: schemas.local.map((tool) => ({ ...tool, description: LOCAL_TOOL_DESCRIPTIONS[tool.name] ?? '' })),
      remote: schemas.remote.map((tool) => ({ ...tool, description: REMOTE_TOOL_DESCRIPTIONS[tool.name] ?? '' })),
      resources: [
        'localehub://projects/{projectId}',
        'localehub://projects/{projectId}/locales',
        'localehub://projects/{projectId}/glossary',
        'localehub://projects/{projectId}/style-guide',
        'localehub://projects/{projectId}/qa-rules',
        'localehub://projects/{projectId}/sync-status',
      ],
      prompts: ['sync-localization-project', 'review-localization-changes', 'fix-translation-issues', 'prepare-localization-release'],
      // What a client should connect to. Not a secret, and the UI cannot guess it: behind nginx
      // this is the public host, in development it is :3003.
      remoteUrl,
      // Rendered server-side from the same generator the CLI uses. The web bundle cannot import
      // @localehub/contracts (it reaches node:crypto), and duplicating the snippet logic in the
      // browser is how the two would drift apart.
      snippets: {
        remoteOnly: formatMcpClientConfig(mcpClientConfig({ remote: { url: remoteUrl } })),
        localAndRemote: formatMcpClientConfig(
          mcpClientConfig({ local: { apiUrl }, remote: { url: remoteUrl } }),
        ),
        claudeCli: claudeCliCommand({ url: remoteUrl }),
      },
    };
  }
}
