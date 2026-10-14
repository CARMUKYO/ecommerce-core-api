import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import fp from "fastify-plugin";
import { env } from "../../config/env.js";
import { AppError, ErrorCodes } from "../errors.js";

export interface SecurityOptions {
  rateLimit: boolean;
  corsOrigins: string[];
}

function rateLimitedError(retryAfterSeconds: number): AppError {
  return new AppError({
    statusCode: 429,
    code: ErrorCodes.RATE_LIMITED,
    message: "Too many requests; please retry later",
    details: { retryAfterSeconds },
  });
}

/**
 * Security headers, CORS and rate limiting. Must be registered before any
 * routes: the rate limiter attaches itself to routes as they are declared.
 */
const securityPluginImpl: FastifyPluginAsync<SecurityOptions> = async (app, opts) => {
  await app.register(helmet);

  // Deny cross-origin browser access unless the origin is explicitly allowlisted.
  await app.register(cors, { origin: opts.corsOrigins.length > 0 ? opts.corsOrigins : false });

  if (opts.rateLimit) {
    // Global per-IP limit; routes may override via `config.rateLimit`.
    await app.register(rateLimit, {
      global: true,
      max: env.RATE_LIMIT_MAX,
      timeWindow: "1 minute",
      errorResponseBuilder: (_req, ctx) => rateLimitedError(Math.ceil(ctx.ttl / 1000)),
    });
  }
};

export const securityPlugin = fp(securityPluginImpl, { name: "security-plugin" });

/**
 * Builds a stackable limiter keyed by a custom function, for limits that need
 * the parsed body (e.g. IP + email on login). Returns a preHandler, or
 * undefined when rate limiting is disabled. Unlike `app.rateLimit()`, this
 * runs in addition to the route's own limit rather than being skipped.
 */
export function keyedLimiter(
  app: Parameters<FastifyPluginAsync>[0],
  opts: { max: number; timeWindow: string; key: (req: FastifyRequest) => string },
): ((req: FastifyRequest, reply: FastifyReply) => Promise<void>) | undefined {
  if (!app.hasDecorator("createRateLimit")) return undefined;
  const check = app.createRateLimit({ max: opts.max, timeWindow: opts.timeWindow, keyGenerator: opts.key });
  return async (req, reply) => {
    const result = await check(req);
    if ("isExceeded" in result && result.isExceeded) {
      reply.header("retry-after", String(result.ttlInSeconds));
      throw rateLimitedError(result.ttlInSeconds);
    }
  };
}
