import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { db, pool } from "../../src/db/client.js";
import { sessions } from "../../src/db/schema/index.js";
import { withJobLock } from "../../src/jobs/job-lock.js";
import { JobScheduler } from "../../src/jobs/scheduler.js";
import { authService } from "../../src/modules/auth/auth.service.js";
import { hashSessionToken } from "../../src/modules/auth/credentials.js";
import { createProduct, createUser } from "../helpers/fixtures.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("Production hardening", () => {
  describe("Rate limiting", () => {
    it("applies the global per-IP limit with a 429 RATE_LIMITED envelope and Retry-After", async () => {
      const app = buildApp({}, { rateLimit: true });
      const responses = [];
      for (let i = 0; i < 101; i++) responses.push(await app.inject({ method: "GET", url: "/products" }));

      expect(responses.slice(0, 100).every((r) => r.statusCode === 200)).toBe(true);
      const limited = responses[100]!;
      expect(limited.statusCode).toBe(429);
      expect(limited.json().error).toMatchObject({ code: "RATE_LIMITED", details: { retryAfterSeconds: expect.any(Number) } });
      expect(Number(limited.headers["retry-after"])).toBeGreaterThan(0);
      await app.close();
    });

    it("limits registration to 5 per minute per IP", async () => {
      const app = buildApp({}, { rateLimit: true });
      const codes = [];
      // Invalid bodies: the limit is enforced before validation, and no hashing cost is paid
      for (let i = 0; i < 6; i++) {
        codes.push((await app.inject({ method: "POST", url: "/auth/register", payload: {} })).statusCode);
      }
      expect(codes).toEqual([400, 400, 400, 400, 400, 429]);
      await app.close();
    });

    it("limits login guesses per IP+email to 5/min, without blocking other accounts", async () => {
      const app = buildApp({}, { rateLimit: true });
      const login = (email: string) =>
        app.inject({ method: "POST", url: "/auth/login", payload: { email, password: "wrong-password" } });

      const codes = [];
      for (let i = 0; i < 6; i++) codes.push((await login("Target@Example.com")).statusCode);
      expect(codes).toEqual([401, 401, 401, 401, 401, 429]);

      const limited = await login("target@example.com"); // case-insensitive key
      expect(limited.statusCode).toBe(429);
      expect(limited.headers["retry-after"]).toBeDefined();

      expect((await login("someone-else@example.com")).statusCode).toBe(401);
      await app.close();
    });

    it("caps total login attempts per IP across many emails (20/min)", async () => {
      const app = buildApp({}, { rateLimit: true });
      const codes = [];
      // Empty password fails validation after the limiters: no hashing cost
      for (let i = 0; i < 21; i++) {
        const res = await app.inject({
          method: "POST",
          url: "/auth/login",
          payload: { email: `spray-${i}@example.com`, password: "" },
        });
        codes.push(res.statusCode);
      }
      expect(codes.slice(0, 20).every((c) => c === 400)).toBe(true);
      expect(codes[20]).toBe(429);
      await app.close();
    });

    it("exempts health probes from rate limiting", async () => {
      const app = buildApp({}, { rateLimit: true });
      for (let i = 0; i < 120; i++) {
        expect((await app.inject({ method: "GET", url: "/health" })).statusCode).toBe(200);
      }
      await app.close();
    });
  });

  describe("Security headers & CORS", () => {
    it("sets security headers on every response", async () => {
      const app = buildApp();
      const res = await app.inject({ method: "GET", url: "/health" });
      expect(res.headers["x-content-type-options"]).toBe("nosniff");
      expect(res.headers["x-frame-options"]).toBeDefined();
      expect(res.headers["strict-transport-security"]).toBeDefined();
    });

    it("denies cross-origin browser access by default", async () => {
      const app = buildApp({}, { corsOrigins: [] });
      const res = await app.inject({ method: "GET", url: "/products", headers: { origin: "https://evil.example" } });
      expect(res.headers["access-control-allow-origin"]).toBeUndefined();
    });

    it("allows only allowlisted origins", async () => {
      const app = buildApp({}, { corsOrigins: ["https://shop.example"] });
      const ok = await app.inject({
        method: "OPTIONS",
        url: "/cart/items",
        headers: { origin: "https://shop.example", "access-control-request-method": "POST" },
      });
      expect(ok.headers["access-control-allow-origin"]).toBe("https://shop.example");

      const denied = await app.inject({ method: "GET", url: "/products", headers: { origin: "https://evil.example" } });
      expect(denied.headers["access-control-allow-origin"]).toBeUndefined();
    });
  });

  describe("Database timeouts", () => {
    it("returns 503 SERVICE_BUSY (retryable) when a lock wait exceeds lock_timeout", async () => {
      const app = buildApp();
      const admin = await createUser({ role: "ADMIN" });
      const product = await createProduct({}, { onHand: 10 });

      const blocker = await pool.connect();
      await blocker.query("BEGIN");
      await blocker.query("SELECT 1 FROM inventory WHERE product_id = $1 FOR UPDATE", [product.id]);
      try {
        const res = await app.inject({
          method: "POST",
          url: `/admin/products/${product.id}/inventory/adjustments`,
          headers: { authorization: `Bearer ${admin.token}`, "idempotency-key": randomUUID() },
          payload: { delta: 1, note: "restock" },
        });
        expect(res.statusCode).toBe(503);
        expect(res.json()).toEqual({
          error: { code: "SERVICE_BUSY", message: "The service is busy; please retry shortly" },
        });
        expect(res.headers["retry-after"]).toBe("1");
      } finally {
        await blocker.query("ROLLBACK");
        blocker.release();
      }
    });
  });

  describe("Health & graceful shutdown", () => {
    it("reports liveness and readiness", async () => {
      const app = buildApp();
      expect((await app.inject({ method: "GET", url: "/health" })).json()).toEqual({ status: "ok" });
      const ready = await app.inject({ method: "GET", url: "/ready" });
      expect(ready.statusCode).toBe(200);
      expect(ready.json()).toEqual({ status: "ready" });
    });

    it("lets an in-flight request finish when the server is closed", async () => {
      const app = buildApp();
      app.get("/__slow", async () => {
        await sleep(300);
        return { done: true };
      });
      await app.listen({ port: 0, host: "127.0.0.1" });
      const { port } = app.server.address() as { port: number };

      const inFlight = fetch(`http://127.0.0.1:${port}/__slow`);
      await sleep(50);
      let closedAt = 0;
      const closing = app.close().then(() => {
        closedAt = Date.now();
      });

      const res = await inFlight;
      const respondedAt = Date.now();
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ done: true });
      // The keep-alive socket is told to close, so shutdown doesn't stall on it
      expect(res.headers.get("connection")).toBe("close");
      await closing;
      expect(closedAt - respondedAt).toBeLessThan(1_000);
      await expect(fetch(`http://127.0.0.1:${port}/health`)).rejects.toThrow();
    });
  });

  describe("Background jobs", () => {
    it("purges only expired sessions, in batches", async () => {
      const live = await createUser();
      const expiredUsers = await Promise.all([createUser(), createUser(), createUser()]);
      for (const u of expiredUsers) {
        await db
          .update(sessions)
          .set({ createdAt: new Date(Date.now() - 7_200_000), expiresAt: new Date(Date.now() - 1_000) })
          .where(eq(sessions.userId, u.id));
      }

      expect(await authService.purgeExpiredSessions(2)).toBe(3);
      const remaining = await db.select().from(sessions);
      expect(remaining.map((s) => s.tokenHash)).toEqual([hashSessionToken(live.token)]);
    });

    it("advisory job lock lets only one runner execute a job at a time", async () => {
      let concurrent = 0;
      let maxConcurrent = 0;
      const work = async () => {
        concurrent++;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        await sleep(200);
        concurrent--;
        return 1;
      };

      const [a, b, other] = await Promise.all([
        withJobLock("test-job", work),
        withJobLock("test-job", work),
        withJobLock("another-job", async () => 1),
      ]);
      expect([a.ran, b.ran].sort()).toEqual([false, true]);
      expect(other.ran).toBe(true);
      expect(maxConcurrent).toBe(1);

      // Lock is released afterwards
      expect((await withJobLock("test-job", async () => 1)).ran).toBe(true);
    });

    it("scheduler.stop() waits for an in-flight run and prevents further runs", async () => {
      let runs = 0;
      let finished = 0;
      const scheduler = new JobScheduler(
        [
          {
            name: "slow-test-job",
            intervalMs: 20,
            run: async () => {
              runs++;
              await sleep(150);
              finished++;
              return 0;
            },
          },
        ],
        buildApp().log,
      );
      scheduler.start();
      await sleep(60);
      await scheduler.stop();

      expect(runs).toBeGreaterThanOrEqual(1);
      expect(finished).toBe(runs); // nothing cut off mid-run
      const runsAtStop = runs;
      await sleep(100);
      expect(runs).toBe(runsAtStop);
    });
  });
});
