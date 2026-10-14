import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import fp from "fastify-plugin";
import type { User } from "../../db/schema/users.js";
import { authService } from "../../modules/auth/auth.service.js";
import { AppError, ErrorCodes } from "../errors.js";

declare module "fastify" {
  interface FastifyRequest {
    user: User | null;
    /** The authenticated session, so logout can revoke exactly this one. */
    sessionId: string | null;
  }
  interface FastifyInstance {
    authenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
    requireRole: (role: "ADMIN" | "CUSTOMER") => (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}

const authPluginImpl: FastifyPluginAsync = async (fastify) => {
  fastify.decorateRequest("user", null);
  fastify.decorateRequest("sessionId", null);

  const resolveSessionFromHeader = async (request: FastifyRequest): Promise<{ user: User; sessionId: string }> => {
    const authHeader = request.headers.authorization;
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      throw new AppError({
        statusCode: 401,
        code: ErrorCodes.UNAUTHENTICATED,
        message: "Missing or invalid authorization header",
      });
    }

    const token = authHeader.slice(7).trim();
    if (!token) {
      throw new AppError({
        statusCode: 401,
        code: ErrorCodes.UNAUTHENTICATED,
        message: "Authentication token is required",
      });
    }

    return await authService.authenticate(token);
  };

  fastify.decorate("authenticate", async (request: FastifyRequest, _reply: FastifyReply) => {
    const { user, sessionId } = await resolveSessionFromHeader(request);
    request.user = user;
    request.sessionId = sessionId;
  });

  fastify.decorate("requireRole", (role: "ADMIN" | "CUSTOMER") => {
    return async (request: FastifyRequest, reply: FastifyReply) => {
      if (!request.user) {
        await fastify.authenticate(request, reply);
      }
      if (request.user?.role !== role) {
        throw new AppError({
          statusCode: 403,
          code: ErrorCodes.FORBIDDEN,
          message: "You do not have permission to perform this action",
        });
      }
    };
  });
};

export const authPlugin = fp(authPluginImpl, {
  name: "auth-plugin",
});
