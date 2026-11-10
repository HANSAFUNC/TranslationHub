/**
 * MCP client configuration snippets.
 *
 * Both the CLI (`localehub mcp-config`) and the web UI render these, so they are generated here
 * rather than in either caller — a snippet that disagrees with what the CLI prints is worse than
 * no snippet at all.
 *
 * Two rules the snippets follow:
 *   - the token is always an environment-variable reference, never a literal. A pasted literal
 *     ends up in `.mcp.json`, which people commit.
 *   - the Remote MCP entry contains a URL and a token and nothing else. The remote server has no
 *     filesystem access, so a workspace path there would only imply a capability it does not have.
 */

export interface LocalServerConfigInput {
  /** API base URL the Local MCP should call. */
  apiUrl: string;
  /** Name of the environment variable holding the token, e.g. `LOCALEHUB_TOKEN`. */
  tokenEnv?: string;
  /** Absolute path to `apps/mcp-local/dist/bin.js`. Left as a placeholder when unknown. */
  binPath?: string;
}

export interface RemoteServerConfigInput {
  /** Externally reachable Streamable HTTP endpoint, e.g. `https://localehub.example/mcp`. */
  url: string;
  tokenEnv?: string;
}

export type McpServerEntry =
  | {
      command: string;
      args: string[];
      env: Record<string, string>;
    }
  | {
      type: 'http';
      url: string;
      headers: Record<string, string>;
    };

export interface McpClientConfig {
  mcpServers: Record<string, McpServerEntry>;
}

const DEFAULT_TOKEN_ENV = 'LOCALEHUB_TOKEN';
const LOCAL_BIN_PLACEHOLDER = '<path-to-localehub>/apps/mcp-local/dist/bin.js';

export function localServerConfig(input: LocalServerConfigInput): McpServerEntry {
  const tokenEnv = input.tokenEnv || DEFAULT_TOKEN_ENV;
  return {
    command: 'node',
    args: [input.binPath ?? LOCAL_BIN_PLACEHOLDER, '--stdio', '--workspace', '.'],
    env: {
      LOCALEHUB_API_URL: input.apiUrl,
      LOCALEHUB_WORKSPACE: '.',
      LOCALEHUB_TOKEN: `\${${tokenEnv}}`,
    },
  };
}

export function remoteServerConfig(input: RemoteServerConfigInput): McpServerEntry {
  const tokenEnv = input.tokenEnv || DEFAULT_TOKEN_ENV;
  return {
    type: 'http',
    url: input.url,
    headers: { Authorization: `Bearer \${${tokenEnv}}` },
  };
}

export function mcpClientConfig(input: {
  local?: LocalServerConfigInput | null;
  remote?: RemoteServerConfigInput | null;
}): McpClientConfig {
  const mcpServers: Record<string, McpServerEntry> = {};
  if (input.local) mcpServers['localehub-local'] = localServerConfig(input.local);
  if (input.remote) mcpServers['localehub-remote'] = remoteServerConfig(input.remote);
  return { mcpServers };
}

/** Pretty JSON with a trailing newline, ready to paste into `.mcp.json`. */
export function formatMcpClientConfig(config: McpClientConfig): string {
  return `${JSON.stringify(config, null, 2)}\n`;
}

/**
 * The one-liner a Claude Code user can paste. Quoted so a token containing shell metacharacters
 * cannot break out of the argument.
 */
export function claudeCliCommand(input: RemoteServerConfigInput): string {
  const tokenEnv = input.tokenEnv || DEFAULT_TOKEN_ENV;
  return `claude mcp add --transport http localehub-remote ${input.url} --header "Authorization: Bearer $${tokenEnv}"`;
}
