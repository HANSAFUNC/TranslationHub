import { Prisma, PrismaClient } from '@prisma/client';

export const TENANT_ORG_SETTING = 'app.current_org_id';
export const BYPASS_SETTING = 'app.bypass_rls';

/**
 * A tenant scoped Prisma client.
 *
 * Every query runs inside a transaction that first executes
 *   SET LOCAL app.current_org_id = '<org>';
 * so PostgreSQL row level security guarantees isolation even if a caller forgets a
 * `where organizationId` clause. This is the only sanctioned way to read tenant data
 * from application code (spec §0.1.6 / §9.2).
 */
/**
 * Prisma's interactive-transaction default: five seconds.
 *
 * Fine for a request that touches a handful of rows, and the reason a push carrying a few hundred
 * entries died halfway through: the work is bounded by what the caller sent, not by anything the
 * server can predict, and a slow link or a busy database made even modest batches exceed it.
 */
const DEFAULT_TX_TIMEOUT_MS = 5_000;

/**
 * Budget for a call whose row count the caller decides.
 *
 * The import path writes scan → plan → items → translations inside one transaction; at ~5 ms per
 * entry 400 entries is already 2 seconds before the database is busy. Set generously and let the
 * caller cap its own batch — a transaction that is too long is a symptom of a batch that is too
 * large, and both limits are now visible instead of one being a surprise.
 */
const BULK_TX_TIMEOUT_MS = Number(process.env.BULK_TRANSACTION_TIMEOUT_MS ?? 60_000);

export class TenantPrisma {
  constructor(readonly client: PrismaClient) {}

  /** Run `fn` with RLS scoped to one organization. */
  async withOrganization<T>(
    organizationId: string,
    fn: (tx: Prisma.TransactionClient) => Promise<T>,
    options: { timeoutMs?: number } = {},
  ): Promise<T> {
    if (!organizationId) throw new Error('withOrganization requires an organizationId');
    return this.client.$transaction(
      async (tx) => {
        await tx.$executeRawUnsafe(`SELECT set_config($1, $2, true)`, TENANT_ORG_SETTING, organizationId);
        return fn(tx);
      },
      { timeout: options.timeoutMs ?? DEFAULT_TX_TIMEOUT_MS },
    );
  }

  /**
   * Same scoping, for a call that writes a caller-controlled number of rows.
   *
   * Separate method rather than a flag so the call sites read as what they are: a bulk write
   * opting into a larger budget, not a normal request quietly getting five seconds' worth of
   * latitude taken away.
   */
  async withOrganizationBulk<T>(organizationId: string, fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    return this.withOrganization(organizationId, fn, { timeoutMs: BULK_TX_TIMEOUT_MS });
  }

  /**
   * Run `fn` as the privileged maintenance path (no tenant filter).
   * Only reachable through the owner connection / explicit admin jobs.
   */
  async withoutTenantScope<T>(
    fn: (tx: Prisma.TransactionClient) => Promise<T>,
    options: { timeoutMs?: number } = {},
  ): Promise<T> {
    return this.client.$transaction(
      async (tx) => {
        await tx.$executeRawUnsafe(`SELECT set_config($1, $2, true)`, BYPASS_SETTING, 'on');
        return fn(tx);
      },
      { timeout: options.timeoutMs ?? DEFAULT_TX_TIMEOUT_MS },
    );
  }
}

export { Prisma, PrismaClient };
export type { PrismaClient as PrismaClientType };
