import { Body, Controller, Delete, Get, Param, Post } from '@nestjs/common';
import { ErrorCode, LocaleHubError, McpScope, Role, createMcpTokenSchema, ALL_MCP_SCOPES } from '@localehub/contracts';
import { z } from 'zod';
import { assertRole, type ActorContext } from '@localehub/permissions';
import { generateToken } from '@localehub/domain';
import { Actor, RequireRole } from '../../common/auth';
import { PrismaService } from '../../common/prisma.service';
import { AuditService } from '../../common/audit.service';
import { zodBody } from '../../common/zod.pipe';

@Controller()
export class TokensController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  @Get('mcp/scopes')
  async scopes() {
    return { scopes: ALL_MCP_SCOPES };
  }

  /**
   * Issue a token. Only an interactive user session may create tokens (an MCP token can never
   * mint another token), and never with more scopes than the creator holds (spec §2.2).
   */
  @Post('mcp-tokens')
  @RequireRole(Role.PROJECT_MANAGER)
  async create(@Actor() actor: ActorContext, @Body(zodBody(createMcpTokenSchema)) body: z.infer<typeof createMcpTokenSchema>) {
    if (actor.kind !== 'user') {
      throw new LocaleHubError(ErrorCode.SCOPE_INSUFFICIENT, 'MCP tokens cannot create other tokens', 403);
    }
    for (const projectId of body.projectIds) assertRole(actor, projectId, Role.DEVELOPER);
    if (!body.projectIds.length) assertRole(actor, '', Role.PROJECT_MANAGER);

    const { token, tokenHash, tokenPrefix } = generateToken('mcp');
    const expiresAt = new Date(Date.now() + body.expiresInDays * 24 * 60 * 60 * 1000);
    const scopes = body.scopes.filter((scope) => (ALL_MCP_SCOPES as string[]).includes(scope));
    const client = await this.prisma.tenant.withOrganization(actor.organizationId, (tx) =>
      tx.mcpClient.create({
        data: {
          organizationId: actor.organizationId,
          userId: actor.userId,
          kind: 'MCP',
          name: body.name,
          tokenHash,
          tokenPrefix,
          scopes,
          projectIds: body.projectIds,
          repositoryConnectionId: body.repositoryConnectionId ?? null,
          expiresAt,
        },
      }),
    );
    await this.audit.record({
      organizationId: actor.organizationId,
      actorId: actor.userId,
      action: 'mcp_token.create',
      resourceType: 'mcp_client',
      resourceId: client.id,
      metadata: { name: body.name, scopes, projectIds: body.projectIds, expiresAt: expiresAt.toISOString() },
    });
    return {
      id: client.id,
      name: client.name,
      tokenPrefix: client.tokenPrefix,
      scopes: client.scopes,
      projectIds: client.projectIds,
      expiresAt: client.expiresAt?.toISOString() ?? null,
      // The plaintext token is returned exactly once.
      token,
      hint: 'Store this in an environment variable such as LOCALEHUB_TOKEN. It cannot be retrieved again.',
    };
  }

  @Get('mcp-tokens')
  async list(@Actor() actor: ActorContext) {
    return this.prisma.tenant.withOrganization(actor.organizationId, (tx) =>
      tx.mcpClient.findMany({
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          name: true,
          kind: true,
          tokenPrefix: true,
          scopes: true,
          projectIds: true,
          repositoryConnectionId: true,
          expiresAt: true,
          lastUsedAt: true,
          revokedAt: true,
          createdAt: true,
          userId: true,
        },
      }),
    );
  }

  @Delete('mcp-tokens/:id')
  @RequireRole(Role.PROJECT_MANAGER)
  async revoke(@Actor() actor: ActorContext, @Param('id') id: string) {
    const client = await this.prisma.tenant.withOrganization(actor.organizationId, async (tx) => {
      const found = await tx.mcpClient.findUnique({ where: { id } });
      if (!found) throw new LocaleHubError(ErrorCode.NOT_FOUND, `Token ${id} not found`, 404);
      return tx.mcpClient.update({ where: { id }, data: { revokedAt: new Date() } });
    });
    await this.audit.record({
      organizationId: actor.organizationId,
      actorId: actor.userId,
      action: 'mcp_token.revoke',
      resourceType: 'mcp_client',
      resourceId: id,
      metadata: { name: client.name },
    });
    return { id, revokedAt: client.revokedAt?.toISOString() ?? null };
  }

  /**
   * Introspection endpoint used by the Local MCP on startup: it validates the token and reports
   * the project, scopes, bound connection and current revision (spec §4.2 validation step 1).
   */
  @Get('mcp/token-info')
  async tokenInfo(@Actor() actor: ActorContext) {
    const projects = await this.prisma.tenant.withOrganization(actor.organizationId, (tx) =>
      tx.project.findMany({
        where: { id: { in: actor.boundProjectIds?.length ? actor.boundProjectIds : undefined } },
        select: { id: true, name: true, sourceLocale: true, revision: true },
      }),
    );
    const connections = await this.prisma.tenant.withOrganization(actor.organizationId, async (tx) => {
      if (!actor.mcpClientId) return null;
      const client = await tx.mcpClient.findUnique({
        where: { id: actor.mcpClientId },
        select: { repositoryConnectionId: true },
      });
      if (!client?.repositoryConnectionId) return null;
      return tx.repositoryConnection.findUnique({ where: { id: client.repositoryConnectionId } });
    });
    return {
      organizationId: actor.organizationId,
      userId: actor.userId,
      kind: actor.kind,
      scopes: actor.scopes,
      projects,
      connection: connections,
      canPush: actor.scopes.includes(McpScope.SYNC_PUSH as never) || actor.isPlatformAdmin === true,
      canApply: actor.scopes.includes(McpScope.TRANSLATION_APPLY as never) || actor.isPlatformAdmin === true,
    };
  }
}
