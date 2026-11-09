/**
 * Development seed.
 *
 * Creates a demo organization, users for every role, a project with two locales, glossary
 * terms and a QA rule set — enough to exercise the whole UI and the sync loop without having
 * to click through setup. Idempotent: re-running it only fills in what is missing.
 *
 *   pnpm db:seed
 */
import { loadEnvFiles } from '@localehub/config';
import { PrismaClient, TenantPrisma } from '@localehub/database';
import { hashPassword, generateToken, runQaRules } from '@localehub/domain';

// Load the same environment files the services use (env / .env / localehub.env).
loadEnvFiles(process.cwd());

const prisma = new PrismaClient();
const tenant = new TenantPrisma(prisma);

const DEMO_PASSWORD = process.env.SEED_PASSWORD ?? 'demo-password-123';

const USERS = [
  { email: 'demo@localehub.dev', name: 'Demo Admin', role: 'ORG_OWNER' as const, projectRole: 'PROJECT_MANAGER' as const, platformAdmin: true },
  { email: 'pm@localehub.dev', name: 'Pat Product', role: 'PRODUCT_MANAGER' as const, projectRole: 'PRODUCT_MANAGER' as const, platformAdmin: false },
  { email: 'dev@localehub.dev', name: 'Dana Developer', role: 'DEVELOPER' as const, projectRole: 'DEVELOPER' as const, platformAdmin: false },
  { email: 'translator@localehub.dev', name: 'Taro Translator', role: 'TRANSLATOR' as const, projectRole: 'TRANSLATOR' as const, platformAdmin: false },
  { email: 'reviewer@localehub.dev', name: 'Rin Reviewer', role: 'REVIEWER' as const, projectRole: 'REVIEWER' as const, platformAdmin: false },
];

const GLOSSARY = [
  { term: 'checkout', translations: { 'ja-JP': 'お会計', 'zh-CN': '结算' }, description: 'The payment step, not the shopping cart' },
  { term: 'cart', translations: { 'ja-JP': 'カート', 'zh-CN': '购物车' }, description: 'Shopping cart' },
  { term: 'order', translations: { 'ja-JP': 'ご注文', 'zh-CN': '订单' }, description: 'Customer order' },
];

async function main(): Promise<void> {
  const passwordHash = await hashPassword(DEMO_PASSWORD);

  const organization = await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SELECT set_config('app.bypass_rls', 'on', true)`);
    const existing = await tx.organization.findFirst({ where: { slug: 'demo-organization' } });
    if (existing) return existing;
    return tx.organization.create({ data: { name: 'Demo Organization', slug: 'demo-organization' } });
  });

  console.log(`organization: ${organization.name} (${organization.id})`);

  for (const user of USERS) {
    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SELECT set_config('app.bypass_rls', 'on', true)`);
      const created = await tx.user.upsert({
        where: { email: user.email },
        create: { email: user.email, name: user.name, passwordHash, isPlatformAdmin: user.platformAdmin },
        update: { name: user.name },
      });
      await tx.membership.upsert({
        where: { organizationId_userId: { organizationId: organization.id, userId: created.id } },
        create: { organizationId: organization.id, userId: created.id, role: user.role },
        update: { role: user.role },
      });
    });
    console.log(`  user: ${user.email} (${user.role})`);
  }

  const project = await tenant.withOrganization(organization.id, async (tx) => {
    const existing = await tx.project.findFirst({ where: { organizationId: organization.id, slug: 'demo-app' } });
    const record =
      existing ??
      (await tx.project.create({
        data: {
          organizationId: organization.id,
          name: 'Demo App',
          slug: 'demo-app',
          description: 'Fixture project used by the LocaleHub demo and integration tests',
          sourceLocale: 'en-US',
          defaultPlatform: 'web',
        },
      }));
    for (const [code, name, isSource] of [
      ['en-US', 'English (US)', true],
      ['ja-JP', '日本語', false],
      ['zh-CN', '简体中文', false],
    ] as const) {
      await tx.locale.upsert({
        where: { projectId_code: { projectId: record.id, code } },
        create: { organizationId: organization.id, projectId: record.id, code, name, isSource },
        update: { name },
      });
    }
    await tx.projectPlatform.upsert({
      where: { projectId_platform: { projectId: record.id, platform: 'web' } },
      create: { organizationId: organization.id, projectId: record.id, platform: 'web' },
      update: {},
    });
    const users = await tx.user.findMany({ where: { email: { in: USERS.map((u) => u.email) } } });
    for (const user of users) {
      const seedUser = USERS.find((u) => u.email === user.email);
      if (!seedUser) continue;
      await tx.projectMember.upsert({
        where: { projectId_userId: { projectId: record.id, userId: user.id } },
        create: {
          organizationId: organization.id,
          projectId: record.id,
          userId: user.id,
          role: seedUser.projectRole,
          localeScope: seedUser.projectRole === 'TRANSLATOR' ? ['ja-JP'] : [],
        },
        update: { role: seedUser.projectRole },
      });
    }
    return record;
  });

  console.log(`project: ${project.name} (${project.id})`);

  await tenant.withOrganization(organization.id, async (tx) => {
    for (const term of GLOSSARY) {
      const existing = await tx.glossaryTerm.findFirst({ where: { organizationId: organization.id, projectId: project.id, term: term.term } });
      if (!existing) {
        await tx.glossaryTerm.create({
          data: {
            organizationId: organization.id,
            projectId: project.id,
            term: term.term,
            translations: term.translations,
            description: term.description,
            caseSensitive: false,
          },
        });
      }
    }
  });
  console.log(`glossary: ${GLOSSARY.length} terms`);

  const issued = await tenant.withOrganization(organization.id, async (tx) => {
    const owner = await tx.user.findUniqueOrThrow({ where: { email: 'demo@localehub.dev' } });
    const existing = await tx.mcpClient.findFirst({ where: { organizationId: organization.id, name: 'seed-local-mcp', revokedAt: null } });
    if (existing) return null;
    const generated = generateToken('mcp');
    await tx.mcpClient.create({
      data: {
        organizationId: organization.id,
        userId: owner.id,
        kind: 'MCP',
        name: 'seed-local-mcp',
        tokenHash: generated.tokenHash,
        tokenPrefix: generated.tokenPrefix,
        scopes: ['project.read', 'repository.scan', 'sync.preview', 'sync.push', 'translation.read', 'translation.pull', 'qa.execute'],
        projectIds: [project.id],
        expiresAt: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000),
      },
    });
    return generated;
  });

  // A tiny sample of source + translations so the UI is not empty on first login.
  await tenant.withOrganization(organization.id, async (tx) => {
    const sourceLocale = await tx.locale.findUniqueOrThrow({ where: { projectId_code: { projectId: project.id, code: 'en-US' } } });
    const targetLocale = await tx.locale.findUniqueOrThrow({ where: { projectId_code: { projectId: project.id, code: 'ja-JP' } } });
    const namespace = await tx.namespace.upsert({
      where: { projectId_platform_name: { projectId: project.id, platform: 'web', name: 'common' } },
      create: { organizationId: organization.id, projectId: project.id, platform: 'web', name: 'common' },
      update: {},
    });
    const samples: { key: string; source: string; target: string | null }[] = [
      { key: 'checkout.pay_now', source: 'Pay now', target: '今すぐ支払う' },
      { key: 'checkout.cart_empty', source: 'Your cart is empty', target: 'カートは空です' },
      { key: 'greeting', source: 'Hello {name}, you have %d new messages', target: 'こんにちは {name}、新着メッセージが %d 件あります' },
      { key: 'order.history.title', source: 'Order history', target: null },
    ];
    const { contentHash } = await import('@localehub/contracts');
    for (const sample of samples) {
      const key = await tx.translationKey.upsert({
        where: { projectId_platform_namespaceId_key: { projectId: project.id, platform: 'web', namespaceId: namespace.id, key: sample.key } },
        create: { organizationId: organization.id, projectId: project.id, platform: 'web', namespaceId: namespace.id, key: sample.key },
        update: {},
      });
      const sourceVersion = await tx.sourceVersion.upsert({
        where: { keyId_version: { keyId: key.id, version: 1 } },
        create: {
          organizationId: organization.id,
          projectId: project.id,
          keyId: key.id,
          version: 1,
          value: sample.source,
          contentHash: contentHash(sample.source),
        },
        update: {},
      });
      const entry = await tx.translationEntry.upsert({
        where: { keyId_localeId: { keyId: key.id, localeId: sourceLocale.id } },
        create: {
          organizationId: organization.id,
          projectId: project.id,
          keyId: key.id,
          localeId: sourceLocale.id,
          localeCode: sourceLocale.code,
          value: sample.source,
          contentHash: contentHash(sample.source),
          status: 'APPROVED',
          basedOnSourceVersionId: sourceVersion.id,
        },
        update: {},
      });
      const version = await tx.translationVersion.upsert({
        where: { entryId_version: { entryId: entry.id, version: 1 } },
        create: {
          organizationId: organization.id,
          projectId: project.id,
          entryId: entry.id,
          version: 1,
          value: sample.source,
          contentHash: contentHash(sample.source),
          status: 'APPROVED',
          authorType: 'system',
        },
        update: {},
      });
      if (!entry.currentVersionId) {
        await tx.translationEntry.update({ where: { id: entry.id }, data: { currentVersionId: version.id } });
      }
      if (sample.target) {
        const targetEntry = await tx.translationEntry.upsert({
          where: { keyId_localeId: { keyId: key.id, localeId: targetLocale.id } },
          create: {
            organizationId: organization.id,
            projectId: project.id,
            keyId: key.id,
            localeId: targetLocale.id,
            localeCode: targetLocale.code,
            value: sample.target,
            contentHash: contentHash(sample.target),
            status: 'APPROVED',
            basedOnSourceVersionId: sourceVersion.id,
          },
          update: {},
        });
        const targetVersion = await tx.translationVersion.upsert({
          where: { entryId_version: { entryId: targetEntry.id, version: 1 } },
          create: {
            organizationId: organization.id,
            projectId: project.id,
            entryId: targetEntry.id,
            version: 1,
            value: sample.target,
            contentHash: contentHash(sample.target),
            status: 'APPROVED',
            authorType: 'system',
          },
          update: {},
        });
        if (!targetEntry.currentVersionId) {
          await tx.translationEntry.update({ where: { id: targetEntry.id }, data: { currentVersionId: targetVersion.id } });
        }
      }
    }
    // A draft and a pending review so the review queue is not empty.
    const pending = await tx.translationEntry.findFirst({ where: { projectId: project.id, localeCode: 'ja-JP', value: '' } });
    if (pending) {
      await tx.translationEntry.update({ where: { id: pending.id }, data: { status: 'PENDING_REVIEW', value: '注文履歴', contentHash: contentHash('注文履歴') } });
    }
  });

  // QA seed run so the quality centre has data.
  await tenant.withOrganization(organization.id, async (tx) => {
    const sourceLocale = await tx.locale.findUniqueOrThrow({ where: { projectId_code: { projectId: project.id, code: 'en-US' } } });
    const entries = await tx.translationEntry.findMany({
      where: { projectId: project.id },
      include: { key: { include: { namespace: true, sourceVersions: { orderBy: { version: 'desc' }, take: 1 } } } },
    });
    const findings = runQaRules(
      entries.map((entry) => ({
        entryId: entry.id,
        key: entry.key.key,
        locale: entry.localeCode,
        platform: entry.key.platform,
        namespace: entry.key.namespace.name,
        value: entry.value,
        status: entry.status,
        sourceValue: entry.key.sourceVersions[0]?.value ?? '',
        sourceLocale: sourceLocale.code,
      })),
    );
    const run = await tx.qaRun.create({
      data: { organizationId: organization.id, projectId: project.id, status: 'SUCCEEDED', scope: { source: 'seed' }, startedAt: new Date(), finishedAt: new Date(), issueCount: findings.length },
    });
    if (findings.length) {
      await tx.qaIssue.createMany({
        data: findings.map((finding) => ({
          organizationId: organization.id,
          projectId: project.id,
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
    console.log(`qa: ${findings.length} seeded issue(s)`);
  });

  console.log('\nseed complete\n');
  console.log('sign in at http://localhost:3000/login');
  for (const user of USERS) console.log(`  ${user.email.padEnd(28)} ${DEMO_PASSWORD}  (${user.role})`);
  if (issued) {
    console.log(`\nMCP token for the demo project (shown once):\n  ${issued.token}`);
  } else {
    console.log('\nAn MCP token named seed-local-mcp already exists; create a new one in the UI.');
  }
  console.log(`\nPut this in demo-app/.localehub/config.yaml:\n  project:\n    id: "${project.id}"`);
}

main()
  .catch((error) => {
    console.error('seed failed:', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
