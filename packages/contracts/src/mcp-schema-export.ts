import { zodToJsonSchema } from 'zod-to-json-schema';
import { REMOTE_MCP_TOOLS, remoteToolSchemas } from './mcp-tools';

export interface McpToolDescriptor {
  name: string;
  server: 'remote';
  inputSchema: Record<string, unknown> | null;
}

/**
 * JSON Schema export for documentation, the CLI and the platform's tool-discovery endpoint.
 *
 * The heavy zod union is erased with an explicit cast here, inside the package that owns the
 * schemas; consumers receive plain objects and never instantiate the union type themselves.
 */
export function mcpToolJsonSchemas(): { remote: McpToolDescriptor[] } {
  return {
    remote: REMOTE_MCP_TOOLS.map((name) => ({
      name,
      server: 'remote' as const,
      inputSchema: toJsonSchema((remoteToolSchemas as Record<string, unknown>)[name]),
    })),
  };
}

function toJsonSchema(schema: unknown): Record<string, unknown> | null {
  if (!schema) return null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return zodToJsonSchema(schema as any, { target: 'jsonSchema7', $refStrategy: 'none' }) as Record<string, unknown>;
  } catch {
    return null;
  }
}
