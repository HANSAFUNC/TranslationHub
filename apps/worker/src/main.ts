import 'reflect-metadata';
import IORedis from 'ioredis';
import { PrismaClient } from '@localehub/database';
import { loadEnv } from '@localehub/config';
import { startWorker } from './jobs';

async function main(): Promise<void> {
  const env = loadEnv();
  const connection = new IORedis(process.env.REDIS_URL ?? env.REDIS_URL, { maxRetriesPerRequest: null });
  const prisma = new PrismaClient();
  await prisma.$connect();

  const workers = startWorker(connection, prisma);
  console.log(`[worker] started ${workers.length} queues: ${workers.map((worker) => worker.name).join(', ')}`);

  const shutdown = async (signal: string) => {
    console.log(`[worker] ${signal} received, draining…`);
    await Promise.all(workers.map((worker) => worker.close()));
    await prisma.$disconnect();
    await connection.quit();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((error) => {
  console.error('[worker] failed to start:', error);
  process.exit(1);
});
