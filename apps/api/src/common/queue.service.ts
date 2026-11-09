import { Injectable, type OnModuleDestroy } from '@nestjs/common';
import { Queue, type JobsOptions } from 'bullmq';
import IORedis from 'ioredis';

export const QUEUE_NAMES = {
  QA: 'qa',
  IMPORT_EXPORT: 'import-export',
  NOTIFICATIONS: 'notifications',
  AI: 'ai',
} as const;

/**
 * BullMQ producer used by the API. Jobs are idempotent and carry the ids needed to re-run
 * them safely (spec §15 "Worker 崩溃: BullMQ 重试, Job 幂等").
 */
@Injectable()
export class QueueService implements OnModuleDestroy {
  private readonly connection: IORedis;
  private readonly queues = new Map<string, Queue>();

  constructor() {
    this.connection = new IORedis(process.env.REDIS_URL ?? 'redis://127.0.0.1:56379', {
      maxRetriesPerRequest: null,
      lazyConnect: false,
    });
    this.connection.on('error', () => {
      /* the API must stay up even if Redis is briefly unavailable */
    });
  }

  queue(name: string): Queue {
    let queue = this.queues.get(name);
    if (!queue) {
      queue = new Queue(name, { connection: this.connection });
      this.queues.set(name, queue);
    }
    return queue;
  }

  async enqueue<T extends object>(name: string, jobName: string, payload: T, options: JobsOptions = {}): Promise<{ jobId: string | null; queued: boolean }> {
    try {
      const job = await this.queue(name).add(jobName, payload, {
        attempts: 3,
        backoff: { type: 'exponential', delay: 2000 },
        removeOnComplete: 500,
        removeOnFail: 1000,
        ...options,
      });
      return { jobId: job.id ?? null, queued: true };
    } catch {
      // Queue unavailability must not fail the request; the caller can retry synchronously.
      return { jobId: null, queued: false };
    }
  }

  async health(): Promise<{ ok: boolean; queues: Record<string, number> }> {
    const counts: Record<string, number> = {};
    try {
      for (const name of Object.values(QUEUE_NAMES)) {
        counts[name] = await this.queue(name).count();
      }
      return { ok: true, queues: counts };
    } catch {
      return { ok: false, queues: counts };
    }
  }

  async onModuleDestroy(): Promise<void> {
    for (const queue of this.queues.values()) await queue.close().catch(() => undefined);
    await this.connection.quit().catch(() => undefined);
  }
}
