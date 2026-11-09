import { Injectable } from '@nestjs/common';
import { ErrorCode, LocaleHubError, Role, canonicalizeLocaleTag, isValidLocaleTag } from '@localehub/contracts';
import { assertRole, type ActorContext } from '@localehub/permissions';
import { emitProjectEvent } from '@localehub/domain';
import { PrismaService } from '../../common/prisma.service';

@Injectable()
export class ProjectsService {
  constructor(private readonly prisma: PrismaService) {}

  async list(actor: ActorContext) {
    return this.prisma.tenant.withOrganization(actor.organizationId, async (tx) => {
      const projects = await tx.project.findMany({
        where: actor.isPlatformAdmin || actor.kind === 'user' ? {} : { id: { in: actor.boundProjectIds?.length ? actor.boundProjectIds : undefined } },
        orderBy: { createdAt: 'asc' },
        include: { _count: { select: { keys: true, locales: true, entries: true } } },
      });
      return projects.map((project) => ({
        id: project.id,
        name: project.name,
        slug: project.slug,
        description: project.description,
        sourceLocale: project.sourceLocale,
        defaultPlatform: project.defaultPlatform,
        revision: project.revision,
        counts: project._count,
        role: actor.projectRoles[project.id] ?? actor.orgRole,
      }));
    });
  }

  async create(
    actor: ActorContext,
    input: { name: string; slug?: string; description?: string; sourceLocale: string; defaultPlatform?: string; locales?: string[]; platforms?: string[] },
  ) {
    if (!isValidLocaleTag(input.sourceLocale)) {
      throw new LocaleHubError(ErrorCode.INVALID_LOCALE, `Invalid source locale: ${input.sourceLocale}`, 422);
    }
    const slug = input.slug ?? slugify(input.name);
    return this.prisma.tenant.withOrganization(actor.organizationId, async (tx) => {
      const project = await tx.project.create({
        data: {
          organizationId: actor.organizationId,
          name: input.name,
          slug,
          description: input.description ?? null,
          sourceLocale: canonicalizeLocaleTag(input.sourceLocale),
          defaultPlatform: (input.defaultPlatform ?? 'web') as never,
        },
      });
      const locales = new Set([project.sourceLocale, ...(input.locales ?? []).map(canonicalizeLocaleTag)]);
      for (const code of locales) {
        await tx.locale.create({
          data: {
            organizationId: actor.organizationId,
            projectId: project.id,
            code,
            name: code,
            isSource: code === project.sourceLocale,
          },
        });
      }
      for (const platform of new Set(input.platforms ?? [project.defaultPlatform])) {
        await tx.projectPlatform.create({
          data: { organizationId: actor.organizationId, projectId: project.id, platform: platform as never },
        });
      }
      await tx.projectMember.upsert({
        where: { projectId_userId: { projectId: project.id, userId: actor.userId } },
        create: { organizationId: actor.organizationId, projectId: project.id, userId: actor.userId, role: 'PROJECT_MANAGER' },
        update: {},
      });
      return project;
    });
  }

  async get(actor: ActorContext, projectId: string) {
    assertRole(actor, projectId, Role.READONLY);
    return this.prisma.tenant.withOrganization(actor.organizationId, async (tx) => {
      const project = await tx.project.findUnique({
        where: { id: projectId },
        include: {
          locales: { orderBy: { code: 'asc' } },
          platforms: true,
          connections: { include: { mappings: true } },
        },
      });
      if (!project) throw new LocaleHubError(ErrorCode.NOT_FOUND, `Project ${projectId} not found`, 404);
      return project;
    });
  }

  async update(actor: ActorContext, projectId: string, input: { name?: string; description?: string | null; defaultPlatform?: string; aiPolicy?: unknown }) {
    assertRole(actor, projectId, Role.PROJECT_MANAGER);
    return this.prisma.tenant.withOrganization(actor.organizationId, async (tx) => {
      const project = await tx.project.update({
        where: { id: projectId },
        data: {
          ...(input.name ? { name: input.name } : {}),
          ...(input.description !== undefined ? { description: input.description } : {}),
          ...(input.defaultPlatform ? { defaultPlatform: input.defaultPlatform as never } : {}),
          ...(input.aiPolicy !== undefined ? { aiPolicy: input.aiPolicy as never } : {}),
        },
      });
      await emitProjectEvent(tx, {
        organizationId: actor.organizationId,
        projectId,
        eventType: 'KEY_CREATED',
        resourceType: 'project',
        resourceId: projectId,
        payload: { updated: Object.keys(input) },
        actorId: actor.userId,
        actorType: actor.actorType ?? 'user',
      });
      return project;
    });
  }

  /**
   * Delete a project and everything under it (keys, entries, versions, sync data).
   * Irreversible; reserved for project managers and used by the acceptance demo for cleanup.
   */
  async remove(actor: ActorContext, projectId: string, confirmName?: string): Promise<{ deleted: true; id: string }> {
    assertRole(actor, projectId, Role.PROJECT_MANAGER);
    return this.prisma.tenant.withOrganization(actor.organizationId, async (tx) => {
      const project = await tx.project.findUnique({ where: { id: projectId }, select: { name: true } });
      if (!project) throw new LocaleHubError(ErrorCode.NOT_FOUND, `Project ${projectId} not found`, 404);
      if (confirmName !== undefined && confirmName !== project.name) {
        throw new LocaleHubError(
          ErrorCode.VALIDATION_ERROR,
          `Confirmation name does not match. Pass confirmName="${project.name}" to delete this project.`,
          422,
        );
      }
      await tx.project.delete({ where: { id: projectId } });
      return { deleted: true as const, id: projectId };
    });
  }

  async listLocales(actor: ActorContext, projectId: string) {
    assertRole(actor, projectId, Role.READONLY);
    return this.prisma.tenant.withOrganization(actor.organizationId, (tx) =>
      tx.locale.findMany({ where: { projectId }, orderBy: { code: 'asc' } }),
    );
  }

  async addLocale(actor: ActorContext, projectId: string, input: { code: string; name?: string }) {
    assertRole(actor, projectId, Role.PROJECT_MANAGER);
    if (!isValidLocaleTag(input.code)) {
      throw new LocaleHubError(ErrorCode.INVALID_LOCALE, `Invalid locale: ${input.code}`, 422);
    }
    const code = canonicalizeLocaleTag(input.code);
    return this.prisma.tenant.withOrganization(actor.organizationId, async (tx) => {
      const project = await tx.project.findUniqueOrThrow({ where: { id: projectId }, select: { sourceLocale: true } });
      return tx.locale.upsert({
        where: { projectId_code: { projectId, code } },
        create: {
          organizationId: actor.organizationId,
          projectId,
          code,
          name: input.name ?? code,
          isSource: code === project.sourceLocale,
        },
        update: { name: input.name ?? code },
      });
    });
  }

  async listMembers(actor: ActorContext, projectId: string) {
    assertRole(actor, projectId, Role.READONLY);
    return this.prisma.tenant.withOrganization(actor.organizationId, (tx) =>
      tx.projectMember.findMany({
        where: { projectId },
        include: { user: { select: { id: true, email: true, name: true } } },
      }),
    );
  }

  async addMember(actor: ActorContext, projectId: string, input: { email: string; role: string; localeScope?: string[] }) {
    assertRole(actor, projectId, Role.PROJECT_MANAGER);
    return this.prisma.tenant.withOrganization(actor.organizationId, async (tx) => {
      const user = await tx.user.findUnique({ where: { email: input.email.toLowerCase() } });
      if (!user) throw new LocaleHubError(ErrorCode.NOT_FOUND, `No user with email ${input.email}`, 404);
      const membership = await tx.membership.findUnique({
        where: { organizationId_userId: { organizationId: actor.organizationId, userId: user.id } },
      });
      if (!membership) {
        await tx.membership.create({
          data: { organizationId: actor.organizationId, userId: user.id, role: (input.role as never) ?? 'READONLY' },
        });
      }
      return tx.projectMember.upsert({
        where: { projectId_userId: { projectId, userId: user.id } },
        create: {
          organizationId: actor.organizationId,
          projectId,
          userId: user.id,
          role: input.role as never,
          localeScope: input.localeScope ?? [],
        },
        update: { role: input.role as never, localeScope: input.localeScope ?? [] },
      });
    });
  }

  async addPlatformSafe(actor: ActorContext, projectId: string, platform: string) {
    assertRole(actor, projectId, Role.PROJECT_MANAGER);
    return this.prisma.tenant.withOrganization(actor.organizationId, (tx) =>
      tx.projectPlatform.upsert({
        where: { projectId_platform: { projectId, platform: platform as never } },
        create: { organizationId: actor.organizationId, projectId, platform: platform as never },
        update: {},
      }),
    );
  }

  async dashboard(actor: ActorContext, projectId: string) {
    assertRole(actor, projectId, Role.READONLY);
    return this.prisma.tenant.withOrganization(actor.organizationId, async (tx) => {
      const [keys, entries, byStatus, locales, openConflicts, qaIssues] = await Promise.all([
        tx.translationKey.count({ where: { projectId, archivedAt: null } }),
        tx.translationEntry.count({ where: { projectId } }),
        tx.translationEntry.groupBy({ by: ['status'], where: { projectId }, _count: { _all: true } }),
        tx.locale.count({ where: { projectId } }),
        tx.syncConflict.count({ where: { projectId, status: 'OPEN' } }),
        tx.qaIssue.count({ where: { projectId, status: 'OPEN' } }),
      ]);
      return {
        keys,
        entries,
        locales,
        openConflicts,
        qaIssues,
        byStatus: Object.fromEntries(byStatus.map((row) => [row.status, row._count._all])),
      };
    });
  }
}

export function slugify(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/[\s_]+/g, '-')
    .slice(0, 60) || `project-${Date.now().toString(36)}`;
}
