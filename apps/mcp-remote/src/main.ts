import 'reflect-metadata';
import express, { type Request, type Response } from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { PrismaClient, TenantPrisma } from '@localehub/database';
import { loadEnv } from '@localehub/config';
import { ErrorCode, LocaleHubError, Role } from '@localehub/contracts';
import { hashToken } from '@localehub/domain';
import type { ActorContext } from '@localehub/permissions';
import { buildRemoteMcpServer } from './server';

/**
 * Remote MCP HTTP entry point.
 *
 * Streamable HTTP in stateless mode: every request carries its own bearer token, so there is no
 * server-side session that could leak between tenants. The endpoint exposes platform data only.
 */
async function main(): Promise<void> {
  const env = loadEnv();
  if (process.env.MCP_REMOTE_ENABLED === 'false') {
    console.log('[mcp-remote] disabled via MCP_REMOTE_ENABLED=false');
    return;
  }
  const prisma = new PrismaClient();
  const tenant = new TenantPrisma(prisma);
  const app = express();
  app.use(express.json({ limit: '4mb' }));

  app.get('/health', async (_req, res) => {
    try {
      await prisma.$queryRaw`SELECT 1`;
      res.json({ status: 'ok', service: 'localehub-mcp-remote' });
    } catch {
      res.status(503).json({ status: 'degraded' });
    }
  });

  app.post('/mcp', async (req: Request, res: Response) => {
    try {
      const actor = await authenticate(req, prisma, tenant);
      const server = await buildRemoteMcpServer(actor, prisma, tenant);
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined, // stateless
        enableJsonResponse: true,
      });
      res.on('close', () => {
        void transport.close();
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      const err = error instanceof LocaleHubError ? error : LocaleHubError.from(error);
      res.status(err.status).json({
        jsonrpc: '2.0',
        error: { code: -32001, message: err.message, data: { code: err.code } },
        id: null,
      });
    }
  });

  // MCP clients probe GET for SSE streams; we are stateless so we answer with a clear 405.
  app.get('/mcp', (_req, res) => {
    res.status(405).json({ error: 'This server is stateless; use POST /mcp' });
  });

  const port = Number(process.env.MCP_REMOTE_PORT ?? 3003);
  app.listen(port, '0.0.0.0', () => {
    console.log(`[mcp-remote] listening on :${port}/mcp (stateless streamable HTTP)`);
  });

  void env;
}

async function authenticate(req: Request, prisma: PrismaClient, tenant: TenantPrisma): Promise<ActorContext> {
  const header = req.headers.authorization;
  const token = typeof header === 'string' && header.startsWith('Bearer ') ? header.slice(7).trim() : null;
  if (!token) throw new LocaleHubError(ErrorCode.UNAUTHENTICATED, 'Missing bearer token', 401);

  const client = await tenant.withoutTenantScope((tx) =>
    tx.mcpClient.findUnique({
      where: { tokenHash: hashToken(token) },
      include: { user: { include: { memberships: true, projectRoles: true } } },
    }),
  );
  if (!client) throw new LocaleHubError(ErrorCode.INVALID_TOKEN, 'Unknown token', 401);
  if (client.revokedAt) throw new LocaleHubError(ErrorCode.INVALID_TOKEN, 'Token revoked', 401);
  if (client.expiresAt && client.expiresAt.getTime() < Date.now()) {
    throw new LocaleHubError(ErrorCode.TOKEN_EXPIRED, 'Token expired', 401);
  }
  const membership = client.user.memberships.find((m) => m.organizationId === client.organizationId);
  if (!membership) throw new LocaleHubError(ErrorCode.ORGANIZATION_ACCESS_DENIED, 'Token owner left the organization', 403);

  const projectRoles: Record<string, Role | null> = {};
  for (const role of client.user.projectRoles) projectRoles[role.projectId] = role.role as Role;

  void prisma;
  return {
    kind: 'mcp',
    userId: client.userId,
    organizationId: client.organizationId,
    orgRole: membership.role as Role,
    projectRoles,
    scopes: (client.scopes as never[]) ?? [],
    mcpClientId: client.id,
    isPlatformAdmin: client.user.isPlatformAdmin,
    boundProjectIds: client.projectIds,
    actorType: 'mcp',
  };
}

main().catch((error) => {
  console.error('[mcp-remote] failed to start:', error);
  process.exit(1);
});
