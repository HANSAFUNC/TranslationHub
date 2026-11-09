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
export class TenantPrisma {
  constructor(readonly client: PrismaClient) {}

  /** Run `fn` with RLS scoped to one organization. */
  async withOrganization<T>(organizationId: string, fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    if (!organizationId) throw new Error('withOrganization requires an organizationId');
    return this.client.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SELECT set_config($1, $2, true)`, TENANT_ORG_SETTING, organizationId);
      return fn(tx);
    });
  }

  /**
   * Run `fn` as the privileged maintenance path (no tenant filter).
   * Only reachable through the owner connection / explicit admin jobs.
   */
  async withoutTenantScope<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    return this.client.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SELECT set_config($1, $2, true)`, BYPASS_SETTING, 'on');
      return fn(tx);
    });
  }
}

export { Prisma, PrismaClient };
export type { PrismaClient as PrismaClientType };
