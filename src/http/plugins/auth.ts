import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import fp from "fastify-plugin";
import { eq } from "drizzle-orm";
import { db } from "../../db/client.js";
import { users, type User } from "../../db/schema/users.js";
import { AppError, ErrorCodes } from "../errors.js";

declare module "fastify" {
  interface FastifyRequest {
    user: User | null;
  }
  interface FastifyInstance {
    authenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
    requireRole: (role: "ADMIN" | "CUSTOMER") => (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}

const authPluginImpl: FastifyPluginAsync = async (fastify) => {
  fastify.decorateRequest("user", null);

  const resolveUserFromHeader = async (request: FastifyRequest): Promise<User> => {
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

    // Dev/test auth seam: Bearer token is the user ID UUID
    const [user] = await db.select().from(users).where(eq(users.id, token));
    if (!user) {
      throw new AppError({
        statusCode: 401,
        code: ErrorCodes.UNAUTHENTICATED,
        message: "Invalid authentication credentials",
      });
    }

    if (user.status === "SUSPENDED") {
      throw new AppError({
        statusCode: 403,
        code: ErrorCodes.ACCOUNT_SUSPENDED,
        message: "User account is suspended",
      });
    }

    return user;
  };

  fastify.decorate("authenticate", async (request: FastifyRequest, _reply: FastifyReply) => {
    const user = await resolveUserFromHeader(request);
    request.user = user;
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
