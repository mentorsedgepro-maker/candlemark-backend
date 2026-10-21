import { Queue, Worker, type Job } from 'bullmq';
import { prisma } from '../../lib/prisma.js';
import { redis } from '../../lib/redis.js';
import { executeScheduledMentorTrade } from './trading.service.js';

const QUEUE_NAME = 'scripted-trading-queue';
const SCHEDULER_ID = 'automated-mentor-trade-every-six-hours';

export async function setupTradingCron() {
  const queue = new Queue(QUEUE_NAME, { connection: redis });
  await queue.upsertJobScheduler(
    SCHEDULER_ID,
    { pattern: '0 */6 * * *', tz: 'UTC' },
    {
      name: 'automated-mentor-trade',
      data: {},
      opts: { attempts: 1 },
    },
  );

  const worker = new Worker(
    QUEUE_NAME,
    async (job: Job) => {
      const now = new Date();
      const day = now.getUTCDay();
      if (day === 0 || day === 6) {
        console.info('Market closed (weekend). Skipping scheduled mentor trades.');
        return;
      }

      const mentors = await prisma.mentor.findMany({
        where: { verified: true, user: { status: 'ACTIVE' } },
        select: { id: true },
      });
      const failures: Error[] = [];
      for (const mentor of mentors) {
        try {
          await executeScheduledMentorTrade(mentor.id);
        } catch (error) {
          const failure = error instanceof Error ? error : new Error(String(error));
          failures.push(failure);
          console.error(`Scheduled trade failed for mentor ${mentor.id}:`, failure);
        }
      }
      if (failures.length) throw new AggregateError(failures, 'One or more scheduled mentor trades failed.');
      console.info(`Job ${job.id} processed scheduled trades for ${mentors.length} mentors.`);
    },
    { connection: redis, concurrency: 1 },
  );

  worker.on('completed', (job) => {
    console.info(`Job ${job.id} completed successfully.`);
  });
  worker.on('failed', (job, error) => {
    console.error(`Job ${job?.id ?? 'unknown'} failed:`, error);
  });

  return {
    close: async () => {
      await worker.close();
      await queue.close();
    },
  };
}
