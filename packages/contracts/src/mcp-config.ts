/**
 * MCP client configuration snippet.
 *
 * Both the CLI (`localehub mcp-config`) and the web UI render this, so it is generated here rather
 * than in either caller — a snippet that disagrees with what the CLI prints is worse than no
 * snippet at all.
 *
 * Two rules it follows:
 *   - the token is always an environment-variable reference, never a literal. A pasted literal
 *     ends up in `.mcp.json`, which people commit.
 *   - the entry contains a URL and a token and nothing else. There is one server, it runs on the
 *     platform, and it has no filesystem access — a workspace path would only imply a capability
 *     it does not have.
 */

export interface RemoteServerConfigInput {
  /** Externally reachable Streamable HTTP endpoint, e.g. `https://localehub.example/mcp`. */
  url: string;
  tokenEnv?: string;
}

export type McpServerEntry = {
  type: 'http';
  url: string;
  headers: Record<string, string>;
};

export interface McpClientConfig {
  mcpServers: Record<string, McpServerEntry>;
}

const DEFAULT_TOKEN_ENV = 'LOCALEHUB_TOKEN';

export function remoteServerConfig(input: RemoteServerConfigInput): McpServerEntry {
  const tokenEnv = input.tokenEnv || DEFAULT_TOKEN_ENV;
  return {
    type: 'http',
    url: input.url,
    headers: { Authorization: `Bearer \${${tokenEnv}}` },
  };
}

export function mcpClientConfig(input: { remote: RemoteServerConfigInput }): McpClientConfig {
  return { mcpServers: { 'localehub-remote': remoteServerConfig(input.remote) } };
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
