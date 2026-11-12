/**
 * Rewrite stored locale names to the current label.
 *
 * `locales.name` used to hold whatever the naming function of the day produced — the code itself
 * (`en-US`), the language's own name (`日本語`), a native name with a region suffix
 * (`English · US`), and now Chinese (`日语`, `英语（美国）`). Every read path derives the label from
 * the code, so the column is cosmetic — but a cosmetic column that disagrees with the screen is
 * how "which of these is right" starts.
 *
 * Run once: `node scripts/backfill-locale-names.mjs [--dry-run]`
 */
import { createRequire } from 'node:module';

const require = createRequire(new URL('../packages/database/package.json', import.meta.url));
const { PrismaClient } = require('@prisma/client');
const { localeDisplayName } = require('@localehub/contracts');

const dryRun = process.argv.includes('--dry-run');
const prisma = new PrismaClient();

try {
  const rows = await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SELECT set_config('app.bypass_rls', 'on', true)`);
    return tx.locale.findMany({ select: { id: true, code: true, name: true } });
  });

  const changes = rows
    .map((row) => ({ ...row, next: localeDisplayName(row.code) }))
    .filter((row) => row.name !== row.next);

  console.log(`${rows.length} locale(s), ${changes.length} to update${dryRun ? ' (dry run)' : ''}`);
  for (const change of changes.slice(0, 10)) {
    console.log(`  ${change.code}: ${change.name} → ${change.next}`);
  }
  if (changes.length > 10) console.log(`  …and ${changes.length - 10} more`);

  if (!dryRun && changes.length) {
    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SELECT set_config('app.bypass_rls', 'on', true)`);
      for (const change of changes) {
        await tx.locale.update({ where: { id: change.id }, data: { name: change.next } });
      }
    });
    console.log(`updated ${changes.length} row(s)`);
  }
} finally {
  await prisma.$disconnect();
}
