import { Controller, Get } from '@nestjs/common';
import { mcpToolJsonSchemas } from '@localehub/contracts';
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
    };
  }
}
