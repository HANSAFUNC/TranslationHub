import { Injectable } from '@nestjs/common';
import { ErrorCode, LocaleHubError, Role, canonicalizeLocaleTag, isValidLocaleTag, localeDisplayName, resolveLocaleTag } from '@localehub/contracts';
import { assertRole, type ActorContext } from '@localehub/permissions';
import { createProject, emitProjectEvent, slugify } from '@localehub/domain';
import { PrismaService } from '../../common/prisma.service';

@Injectable()
export class ProjectsService {
  constructor(private readonly prisma: PrismaService) {}

  async list(actor: ActorContext) {
    return this.prisma.tenant.withOrganization(actor.organizationId, async (tx) => {
      const projects = await tx.project.findMany({
        where:
          actor.isPlatformAdmin || actor.kind === 'user'
            ? {}
            : { id: { in: actor.boundProjectIds?.length ? actor.boundProjectIds : undefined } },
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
    input: {
      name: string;
      slug?: string;
      description?: string;
      sourceLocale: string;
      defaultPlatform?: string;
      locales?: string[];
      platforms?: string[];
    },
  ) {
    // Creating a project carries no `:projectId`, so the guard's `@RequireRole(PROJECT_MANAGER)` on
    // this route decides nothing on its own — the guard only applies that decorator when the
    // request names a project. Without the check below, any member (a READONLY included) could
    // create projects in the organization; verified against the running API. Same trap and same
    // fix as `POST /skills` and `DELETE /mcp-tokens/:id` (docs/STATUS.md §1.11, §1.14).
    assertRole(actor, '', Role.PROJECT_MANAGER);
    if (!isValidLocaleTag(input.sourceLocale)) {
      throw new LocaleHubError(ErrorCode.INVALID_LOCALE, `Invalid source locale: ${input.sourceLocale}`, 422);
    }
    // Shared with the Remote MCP's `create_project`: one implementation, so a project created by
    // an agent and one created in the UI cannot differ in locales, platforms or membership.
    return this.prisma.tenant.withOrganization(actor.organizationId, (tx) =>
      createProject(tx, {
        organizationId: actor.organizationId,
        userId: actor.userId,
        name: input.name,
        slug: input.slug,
        description: input.description,
        sourceLocale: input.sourceLocale,
        defaultPlatform: input.defaultPlatform,
        locales: input.locales,
        platforms: input.platforms,
      }),
    );
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

  async update(
    actor: ActorContext,
    projectId: string,
    input: {
      name?: string;
      description?: string | null;
      defaultPlatform?: string;
      aiPolicy?: unknown;
      platforms?: string[];
      sourceLocale?: string;
    },
  ) {
    assertRole(actor, projectId, Role.PROJECT_MANAGER);
    return this.prisma.tenant.withOrganization(actor.organizationId, async (tx) => {
      const current = await tx.project.findUniqueOrThrow({
        where: { id: projectId },
        select: { sourceLocale: true },
      });

      if (input.sourceLocale !== undefined) {
        const sourceLocale = canonicalizeLocaleTag(input.sourceLocale);
        if (!isValidLocaleTag(sourceLocale)) {
          throw new LocaleHubError(ErrorCode.INVALID_LOCALE, `Invalid source locale: ${input.sourceLocale}`, 422);
        }
        if (sourceLocale !== current.sourceLocale) {
          // Everything the project knows is anchored to the source: source versions, the "stale"
          // marker on derived translations, the three-way baseline. Re-pointing it after text
          // exists would leave every one of those describing a language that is no longer there.
          const entries = await tx.translationEntry.count({ where: { projectId } });
          if (entries > 0) {
            throw new LocaleHubError(
              ErrorCode.CONFLICT,
              `This project already has ${entries} translation(s). The source locale is what they were derived from and cannot be changed now.`,
              409,
              { entries },
            );
          }
          const [existingSource, target] = await Promise.all([
            tx.locale.findUnique({ where: { projectId_code: { projectId, code: current.sourceLocale } } }),
            tx.locale.findUnique({ where: { projectId_code: { projectId, code: sourceLocale } } }),
          ]);
          if (target) {
            // The new source was already a translation language — a swap, not an addition. Both
            // rows stay; only which one is the source changes.
            await tx.locale.update({ where: { id: target.id }, data: { isSource: true } });
            if (existingSource) await tx.locale.update({ where: { id: existingSource.id }, data: { isSource: false } });
          } else if (existingSource) {
            // Rename in place when the old source has no other role; otherwise it becomes a plain
            // language and the new one takes over as source.
            await tx.locale.update({ where: { id: existingSource.id }, data: { code: sourceLocale, name: localeDisplayName(sourceLocale), isSource: true } });
          } else {
            await tx.locale.create({
              data: {
                organizationId: actor.organizationId,
                projectId,
                code: sourceLocale,
                name: localeDisplayName(sourceLocale),
                isSource: true,
              },
            });
          }
        }
      }

      if (input.platforms) {
        // A set, sent whole: the form is one save, and a platform removed there is removed here.
        const wanted = new Set(input.platforms);
        const existing = await tx.projectPlatform.findMany({ where: { projectId }, select: { platform: true } });
        for (const row of existing) {
          if (!wanted.has(row.platform)) {
            await tx.projectPlatform.delete({ where: { projectId_platform: { projectId, platform: row.platform } } });
          }
        }
        for (const platform of wanted) {
          await tx.projectPlatform.upsert({
            where: { projectId_platform: { projectId, platform: platform as never } },
            create: { organizationId: actor.organizationId, projectId, platform: platform as never },
            update: {},
          });
        }
        if (!wanted.has((input.defaultPlatform ?? '') as string)) {
          // The default platform is a pointer into the set; leaving it dangling breaks new keys.
          input = { ...input, defaultPlatform: [...wanted][0] };
        }
      }

      const project = await tx.project.update({
        where: { id: projectId },
        data: {
          ...(input.name ? { name: input.name } : {}),
          ...(input.description !== undefined ? { description: input.description } : {}),
          ...(input.defaultPlatform ? { defaultPlatform: input.defaultPlatform as never } : {}),
          ...(input.aiPolicy !== undefined ? { aiPolicy: input.aiPolicy as never } : {}),
          ...(input.sourceLocale ? { sourceLocale: canonicalizeLocaleTag(input.sourceLocale) } : {}),
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
      // A second spelling of a language the project already has would split its entries: `zh-Hans`
      // and `zh-CN` are one language, and the import path already treats them that way.
      const existing = await tx.locale.findMany({ where: { projectId }, select: { code: true } });
      const resolution = resolveLocaleTag(code, existing.map((row) => row.code));
      if (resolution.reason === 'ambiguous') {
        throw new LocaleHubError(
          ErrorCode.INVALID_LOCALE,
          `Cannot tell which language "${code}" means: this project already has ${resolution.candidates!.join(' and ')}.`,
          409,
          { incoming: code, candidates: resolution.candidates },
        );
      }
      if (resolution.reason === 'equivalent') {
        throw new LocaleHubError(
          ErrorCode.CONFLICT,
          `This project already has ${resolution.code}, which means the same language as ${code}.`,
          409,
          { requested: code, existing: resolution.code },
        );
      }
      return tx.locale.create({
        data: {
          organizationId: actor.organizationId,
          projectId,
          code,
          name: input.name ?? localeDisplayName(code),
          isSource: code === project.sourceLocale,
        },
      });
    });
  }

  async removeLocale(actor: ActorContext, projectId: string, code: string) {
    assertRole(actor, projectId, Role.PROJECT_MANAGER);
    return this.prisma.tenant.withOrganization(actor.organizationId, async (tx) => {
      const project = await tx.project.findUniqueOrThrow({ where: { id: projectId }, select: { sourceLocale: true } });
      if (canonicalizeLocaleTag(code) === project.sourceLocale) {
        throw new LocaleHubError(
          ErrorCode.VALIDATION_ERROR,
          'The source locale cannot be removed; it is what every other translation is based on.',
          409,
        );
      }
      const entries = await tx.translationEntry.count({ where: { projectId, localeCode: code } });
      if (entries > 0) {
        // Deleting the locale would cascade the translations away. That is a decision for a person
        // with the numbers in front of them, not a side effect of tidying a list.
        throw new LocaleHubError(
          ErrorCode.CONFLICT,
          `${entries} translation(s) exist for ${code}. Delete them first, or keep the locale.`,
          409,
          { locale: code, entries },
        );
      }
      await tx.locale.delete({ where: { projectId_code: { projectId, code } } });
      return { removed: code };
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

  async removePlatformSafe(actor: ActorContext, projectId: string, platform: string) {
    assertRole(actor, projectId, Role.PROJECT_MANAGER);
    return this.prisma.tenant.withOrganization(actor.organizationId, async (tx) => {
      const remaining = await tx.projectPlatform.count({ where: { projectId } });
      if (remaining <= 1) {
        throw new LocaleHubError(ErrorCode.CONFLICT, 'A project needs at least one platform.', 409);
      }
      const keys = await tx.translationKey.count({ where: { projectId, platform: platform as never } });
      if (keys > 0) {
        // Keys are scoped by platform; removing it would hide them rather than delete them.
        throw new LocaleHubError(
          ErrorCode.CONFLICT,
          `${keys} key(s) exist on ${platform}. Archive them first, or keep the platform.`,
          409,
          { platform, keys },
        );
      }
      await tx.projectPlatform.delete({ where: { projectId_platform: { projectId, platform: platform as never } } });
      return { removed: platform };
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

export { slugify };
