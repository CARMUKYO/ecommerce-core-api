import type { FastifyPluginAsync } from "fastify";
import { keyedLimiter } from "../../http/plugins/security.js";
import { LoginSchema, RegisterSchema } from "./auth.schemas.js";
import { authService, toPublicUser } from "./auth.service.js";

// Per-route limits replace the global per-IP limit with stricter ones.
const AUTH_IP_LIMIT = { max: 20, timeWindow: "1 minute" };
const REGISTER_IP_LIMIT = { max: 5, timeWindow: "1 minute" };

export const authRoutes: FastifyPluginAsync = async (app) => {
  // Stacked on top of the per-IP limit: caps guesses against one account from
  // one IP. Keyed after body parsing, so the email is available.
  const perAccountLogin = keyedLimiter(app, {
    max: 5,
    timeWindow: "1 minute",
    key: (req) => {
      const email = (req.body as { email?: unknown } | undefined)?.email;
      return `login:${req.ip}:${typeof email === "string" ? email.trim().toLowerCase() : ""}`;
    },
  });

  app.post("/auth/register", { config: { rateLimit: REGISTER_IP_LIMIT } }, async (request, reply) => {
    const body = RegisterSchema.parse(request.body);
    const user = await authService.register(body);
    return reply.status(201).send({ user });
  });

  app.post(
    "/auth/login",
    { config: { rateLimit: AUTH_IP_LIMIT }, preHandler: perAccountLogin ? [perAccountLogin] : [] },
    async (request, reply) => {
      const body = LoginSchema.parse(request.body);
      const result = await authService.login(body);
      return reply.status(200).send(result);
    },
  );

  app.post("/auth/logout", { onRequest: [app.authenticate] }, async (request, reply) => {
    await authService.logout(request.sessionId!);
    return reply.status(204).send();
  });

  app.get("/auth/me", { onRequest: [app.authenticate] }, async (request, reply) => {
    return reply.status(200).send({ user: toPublicUser(request.user!) });
  });
};
