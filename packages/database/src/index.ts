import { PrismaClient } from '@prisma/client';
import { TenantPrisma } from './tenant-prisma';

let singleton: PrismaClient | null = null;

export function createPrismaClient(datasourceUrl?: string): PrismaClient {
  return new PrismaClient({
    log: process.env.PRISMA_LOG === '1' ? ['query', 'warn', 'error'] : ['warn', 'error'],
    ...(datasourceUrl ? { datasources: { db: { url: datasourceUrl } } } : {}),
  });
}

export function getPrismaClient(): PrismaClient {
  if (!singleton) singleton = createPrismaClient();
  return singleton;
}

export function getTenantPrisma(): TenantPrisma {
  return new TenantPrisma(getPrismaClient());
}

export async function disconnect(): Promise<void> {
  if (singleton) {
    await singleton.$disconnect();
    singleton = null;
  }
}

export async function healthCheck(client: PrismaClient = getPrismaClient()): Promise<boolean> {
  try {
    await client.$queryRaw`SELECT 1`;
    return true;
  } catch {
    return false;
  }
}

export * from './tenant-prisma';
