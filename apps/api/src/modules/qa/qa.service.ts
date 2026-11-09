import { Injectable } from '@nestjs/common';
import { ErrorCode, LocaleHubError, Role, type QaSeverity } from '@localehub/contracts';
import { assertRole, type ActorContext } from '@localehub/permissions';
import { BUILTIN_QA_RULES, runQaRules, type QaCandidateEntry } from '@localehub/domain';
import { PrismaService } from '../../common/prisma.service';

@Injectable()
export class QaService {
  constructor(private readonly prisma: PrismaService) {}

  rules() {
    return BUILTIN_QA_RULES;
  }

  /**
   * Run the rule engine for a project (optionally scoped to one locale) and persist the
   * findings. Re-running replaces the previous OPEN findings for the same entries, so the
   * queue never fills with duplicates.
   */
  async run(actor: ActorContext, projectId: string, input: { locale?: string; entryIds?: string[]; enabledRules?: string[]; disabledRules?: string[] } = {}) {
    assertRole(actor, projectId, Role.TRANSLATOR);
    return this.prisma.tenant.withOrganization(actor.organizationId, async (tx) => {
      const project = await tx.project.findUnique({ where: { id: projectId }, select: { sourceLocale: true } });
      if (!project) throw new LocaleHubError(ErrorCode.NOT_FOUND, `Project ${projectId} not found`, 404);

      const run = await tx.qaRun.create({
        data: {
          organizationId: actor.organizationId,
          projectId,
          status: 'RUNNING',
          triggeredById: actor.userId,
          scope: { locale: input.locale ?? null, entryIds: input.entryIds ?? null } as never,
          startedAt: new Date(),
        },
      });

      const entries = await tx.translationEntry.findMany({
        where: {
          projectId,
          ...(input.locale ? { localeCode: input.locale } : {}),
          ...(input.entryIds?.length ? { id: { in: input.entryIds } } : {}),
        },
        include: { key: { include: { namespace: true, sourceVersions: { orderBy: { version: 'desc' }, take: 1 } } } },
      });
      const glossary = await tx.glossaryTerm.findMany({ where: { organizationId: actor.organizationId, OR: [{ projectId }, { projectId: null }] } });

      const candidates: QaCandidateEntry[] = entries.map((entry) => ({
        entryId: entry.id,
        key: entry.key.key,
        locale: entry.localeCode,
        platform: entry.key.platform,
        namespace: entry.key.namespace.name,
        value: entry.value,
        status: entry.status,
        sourceValue: entry.key.sourceVersions[0]?.value ?? '',
        sourceLocale: project.sourceLocale,
        glossaryTerms: glossary.map((term) => ({
          term: term.term,
          translations: (term.translations ?? {}) as Record<string, string>,
          caseSensitive: term.caseSensitive,
        })),
      }));

      const findings = runQaRules(candidates, { enabledRules: input.enabledRules, disabledRules: input.disabledRules });

      const entryIds = entries.map((entry) => entry.id);
      if (entryIds.length) {
        await tx.qaIssue.deleteMany({ where: { projectId, entryId: { in: entryIds }, status: 'OPEN' } });
      }
      if (findings.length) {
        await tx.qaIssue.createMany({
          data: findings.map((finding) => ({
            organizationId: actor.organizationId,
            projectId,
            runId: run.id,
            entryId: finding.entryId,
            translationKey: finding.key,
            localeCode: finding.locale,
            ruleCode: finding.ruleCode,
            severity: finding.severity,
            message: finding.message,
            details: finding.details as never,
          })),
        });
      }

      const updated = await tx.qaRun.update({
        where: { id: run.id },
        data: { status: 'SUCCEEDED', finishedAt: new Date(), issueCount: findings.length },
      });

      return {
        runId: updated.id,
        status: updated.status,
        entriesScanned: entries.length,
        issueCount: findings.length,
        bySeverity: {
          ERROR: findings.filter((f) => f.severity === 'ERROR').length,
          WARNING: findings.filter((f) => f.severity === 'WARNING').length,
          INFO: findings.filter((f) => f.severity === 'INFO').length,
        },
        issues: findings.slice(0, 200),
      };
    });
  }

  async listIssues(
    actor: ActorContext,
    projectId: string,
    filters: { locale?: string; severity?: QaSeverity; status?: 'OPEN' | 'RESOLVED' | 'IGNORED'; limit?: number } = {},
  ) {
    assertRole(actor, projectId, Role.READONLY);
    return this.prisma.tenant.withOrganization(actor.organizationId, (tx) =>
      tx.qaIssue.findMany({
        where: {
          projectId,
          ...(filters.locale ? { localeCode: filters.locale } : {}),
          ...(filters.severity ? { severity: filters.severity } : {}),
          status: filters.status ?? 'OPEN',
        },
        orderBy: [{ severity: 'asc' }, { createdAt: 'desc' }],
        take: Math.min(filters.limit ?? 100, 500),
      }),
    );
  }

  async report(actor: ActorContext, projectId: string) {
    assertRole(actor, projectId, Role.READONLY);
    return this.prisma.tenant.withOrganization(actor.organizationId, async (tx) => {
      const [open, byRule, byLocale, runs] = await Promise.all([
        tx.qaIssue.count({ where: { projectId, status: 'OPEN' } }),
        tx.qaIssue.groupBy({ by: ['ruleCode', 'severity'], where: { projectId, status: 'OPEN' }, _count: { _all: true } }),
        tx.qaIssue.groupBy({ by: ['localeCode'], where: { projectId, status: 'OPEN' }, _count: { _all: true } }),
        tx.qaRun.findMany({ where: { projectId }, orderBy: { createdAt: 'desc' }, take: 10 }),
      ]);
      return {
        openIssues: open,
        byRule: byRule.map((row) => ({ ruleCode: row.ruleCode, severity: row.severity, count: row._count._all })),
        byLocale: byLocale.map((row) => ({ locale: row.localeCode, count: row._count._all })),
        recentRuns: runs.map((run) => ({
          id: run.id,
          status: run.status,
          issueCount: run.issueCount,
          createdAt: run.createdAt.toISOString(),
        })),
      };
    });
  }
}
