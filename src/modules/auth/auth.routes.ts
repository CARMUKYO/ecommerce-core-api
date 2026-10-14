import type { FastifyPluginAsync } from "fastify";
import { LoginSchema, RegisterSchema } from "./auth.schemas.js";
import { authService, toPublicUser } from "./auth.service.js";

export const authRoutes: FastifyPluginAsync = async (app) => {
  app.post("/auth/register", async (request, reply) => {
    const body = RegisterSchema.parse(request.body);
    const user = await authService.register(body);
    return reply.status(201).send({ user });
  });

  app.post("/auth/login", async (request, reply) => {
    const body = LoginSchema.parse(request.body);
    const result = await authService.login(body);
    return reply.status(200).send(result);
  });

  app.post("/auth/logout", { onRequest: [app.authenticate] }, async (request, reply) => {
    await authService.logout(request.sessionId!);
    return reply.status(204).send();
  });

  app.get("/auth/me", { onRequest: [app.authenticate] }, async (request, reply) => {
    return reply.status(200).send({ user: toPublicUser(request.user!) });
  });
};
