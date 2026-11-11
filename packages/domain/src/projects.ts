import { ErrorCode, LocaleHubError, canonicalizeLocaleTag, isValidLocaleTag } from '@localehub/contracts';
import type { Prisma, PrismaClient } from '@localehub/database';

/**
 * Project creation, shared by the REST API and the Remote MCP.
 *
 * Both surfaces can create a project — the API through `POST /projects`, the MCP through
 * `create_project` — and they have to produce the same thing: the project row, its locales, its
 * platforms, and a project-manager membership for whoever created it. Writing that twice is how
 * the two would drift, so it lives here and both call it.
 */

export interface CreateProjectInput {
  organizationId: string;
  /** Becomes a PROJECT_MANAGER of the new project. */
  userId: string;
  name: string;
  slug?: string;
  description?: string;
  sourceLocale: string;
  defaultPlatform?: string;
  locales?: string[];
  platforms?: string[];
}

export interface CreatedProject {
  id: string;
  name: string;
  slug: string;
  sourceLocale: string;
  defaultPlatform: string;
  revision: number;
  locales: string[];
  platforms: string[];
}

export function slugify(value: string): string {
  return (
    value
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[^\w\s-]/g, '')
      .trim()
      .replace(/[\s_]+/g, '-')
      .slice(0, 60) || `project-${Date.now().toString(36)}`
  );
}

/**
 * Create a project inside an open tenant transaction.
 *
 * Takes the transaction rather than opening one: the caller decides the scope, and a project that
 * fails halfway through must not leave locales behind.
 */
export async function createProject(
  tx: Prisma.TransactionClient,
  input: CreateProjectInput,
): Promise<CreatedProject> {
  if (!isValidLocaleTag(input.sourceLocale)) {
    throw new LocaleHubError(ErrorCode.INVALID_LOCALE, `Invalid source locale: ${input.sourceLocale}`, 422);
  }
  for (const locale of input.locales ?? []) {
    if (!isValidLocaleTag(locale)) {
      throw new LocaleHubError(ErrorCode.INVALID_LOCALE, `Invalid locale: ${locale}`, 422);
    }
  }

  const sourceLocale = canonicalizeLocaleTag(input.sourceLocale);
  const slug = input.slug ?? slugify(input.name);
  const project = await tx.project.create({
    data: {
      organizationId: input.organizationId,
      name: input.name,
      slug,
      description: input.description ?? null,
      sourceLocale,
      defaultPlatform: (input.defaultPlatform ?? 'web') as never,
    },
  });

  // The source locale is always present, whether or not the caller listed it.
  const locales = [...new Set([project.sourceLocale, ...(input.locales ?? []).map(canonicalizeLocaleTag)])];
  for (const code of locales) {
    await tx.locale.create({
      data: {
        organizationId: input.organizationId,
        projectId: project.id,
        code,
        name: code,
        isSource: code === project.sourceLocale,
      },
    });
  }

  const platforms = [...new Set(input.platforms ?? [project.defaultPlatform])];
  for (const platform of platforms) {
    await tx.projectPlatform.create({
      data: { organizationId: input.organizationId, projectId: project.id, platform: platform as never },
    });
  }

  // Whoever creates it can manage it, without needing an organization role change first.
  await tx.projectMember.upsert({
    where: { projectId_userId: { projectId: project.id, userId: input.userId } },
    create: {
      organizationId: input.organizationId,
      projectId: project.id,
      userId: input.userId,
      role: 'PROJECT_MANAGER',
    },
    update: {},
  });

  return {
    id: project.id,
    name: project.name,
    slug: project.slug,
    sourceLocale: project.sourceLocale,
    defaultPlatform: project.defaultPlatform as string,
    revision: project.revision,
    locales,
    platforms,
  };
}

export type { PrismaClient };
