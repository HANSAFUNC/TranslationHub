import { Controller, Get } from '@nestjs/common';
import {
  REMOTE_MCP_PROMPTS,
  REMOTE_MCP_RESOURCES,
  SKILLS_INDEX_URI,
  SKILL_PROMPT_PREFIX,
  SKILL_RESOURCE_TEMPLATE,
  claudeCliCommand,
  formatMcpClientConfig,
  mcpClientConfig,
  mcpToolJsonSchemas,
} from '@localehub/contracts';
import { Public } from '../../common/auth';
import { REMOTE_TOOL_DESCRIPTIONS } from './tool-descriptions';

/**
 * Machine readable MCP discovery.
 *
 * The Remote MCP binary serves the same registry over the real MCP transport; this endpoint
 * exists so the web UI, the CLI and the docs can render tool schemas without speaking MCP.
 * It contains no secrets and grants no filesystem capability.
 *
 * The resources and prompts listed here are the ones the server actually registers, taken from
 * the same constants it registers them under. An earlier version of this endpoint advertised a
 * flat list that included resources no server implemented and prompts belonging to a second,
 * now-removed local server — a discovery endpoint that overstates a capability is worse than none.
 */
@Controller('mcp')
export class McpController {
  @Public()
  @Get('tools')
  tools() {
    const schemas = mcpToolJsonSchemas();
    const remoteUrl = process.env.MCP_PUBLIC_URL || 'http://localhost:3003/mcp';
    return {
      remote: schemas.remote.map((tool) => ({ ...tool, description: REMOTE_TOOL_DESCRIPTIONS[tool.name] ?? '' })),
      resources: [
        ...REMOTE_MCP_RESOURCES,
        // Skill delivery: the index, plus one resource per published skill behind the template.
        SKILLS_INDEX_URI,
        SKILL_RESOURCE_TEMPLATE,
      ],
      prompts: [
        ...REMOTE_MCP_PROMPTS,
        // Plus one per PUBLISHED, PROMPT-kind skill, named `skill-<slug>`.
      ],
      // How a client reads and invokes skills. Served rather than hard-coded in the UI for the
      // same reason as the snippets below: `@localehub/contracts` reaches node:crypto, so the web
      // bundle cannot import the constants, and a second copy of the URI format in the browser is
      // how the two would drift apart.
      skillDelivery: {
        indexUri: SKILLS_INDEX_URI,
        resourceTemplate: SKILL_RESOURCE_TEMPLATE,
        promptPrefix: SKILL_PROMPT_PREFIX,
      },
      // What a client should connect to. Not a secret, and the UI cannot guess it: behind nginx
      // this is the public host, in development it is :3003.
      remoteUrl,
      // Rendered server-side from the same generator the CLI uses. The web bundle cannot import
      // @localehub/contracts (it reaches node:crypto), and duplicating the snippet logic in the
      // browser is how the two would drift apart.
      snippets: {
        remote: formatMcpClientConfig(mcpClientConfig({ remote: { url: remoteUrl } })),
        claudeCli: claudeCliCommand({ url: remoteUrl }),
      },
    };
  }
}
