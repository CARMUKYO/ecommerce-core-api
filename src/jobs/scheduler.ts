import type { FastifyBaseLogger } from "fastify";
import { env } from "../config/env.js";
import { authService } from "../modules/auth/auth.service.js";
import { orderService } from "../modules/orders/order.service.js";
import { withJobLock } from "./job-lock.js";

export interface Job {
  name: string;
  intervalMs: number;
  run: () => Promise<number>;
}

export const jobs: Job[] = [
  {
    // Release stock held by unpaid orders (#9 inventory-hoarding fix).
    name: "expire-pending-orders",
    intervalMs: 60_000,
    run: () => orderService.expirePendingOrders({ ttlMinutes: env.PENDING_ORDER_TTL_MINUTES }),
  },
  {
    name: "purge-expired-sessions",
    intervalMs: 15 * 60_000,
    run: () => authService.purgeExpiredSessions(),
  },
];

/**
 * Minimal in-process scheduler. Timers are unref'd (never keep the process
 * alive), a job never overlaps itself, and `stop()` waits for in-flight runs
 * so graceful shutdown doesn't cut a job off mid-transaction.
 */
export class JobScheduler {
  private timers: NodeJS.Timeout[] = [];
  private running = new Map<string, Promise<void>>();
  private stopped = false;

  constructor(
    private readonly jobList: Job[],
    private readonly log: FastifyBaseLogger,
  ) {}

  start(): void {
    for (const job of this.jobList) {
      const timer = setInterval(() => this.tick(job), job.intervalMs);
      timer.unref();
      this.timers.push(timer);
    }
    this.log.info({ jobs: this.jobList.map((j) => j.name) }, "background jobs started");
  }

  private tick(job: Job): void {
    if (this.stopped || this.running.has(job.name)) return;
    const run = withJobLock(job.name, job.run)
      .then((outcome) => {
        if (outcome.ran && outcome.result > 0) this.log.info({ job: job.name, affected: outcome.result }, "job run");
      })
      .catch((err: unknown) => this.log.error({ err, job: job.name }, "job failed"))
      .finally(() => this.running.delete(job.name));
    this.running.set(job.name, run);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    for (const timer of this.timers) clearInterval(timer);
    await Promise.all(this.running.values());
  }
}
