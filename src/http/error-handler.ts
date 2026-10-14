import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { ZodError } from "zod";
import { AppError, ErrorCodes, type ErrorEnvelope } from "./errors.js";

interface PgErrorLike {
  code?: string;
  constraint?: string;
  cause?: unknown;
}

function findPgError(err: unknown): PgErrorLike | undefined {
  let current: unknown = err;
  for (let depth = 0; depth < 5 && current && typeof current === "object"; depth++) {
    const e = current as PgErrorLike;
    if (typeof e.code === "string" && /^[0-9A-Z]{5}$/.test(e.code)) return e;
    current = e.cause;
  }
  return undefined;
}

export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((error: FastifyError | Error, request: FastifyRequest, reply: FastifyReply) => {
    // 1. Explicit domain AppError
    if (error instanceof AppError) {
      const envelope: ErrorEnvelope = {
        error: {
          code: error.code,
          message: error.message,
          ...(error.details !== undefined ? { details: error.details } : {}),
        },
      };
      return reply.status(error.statusCode).send(envelope);
    }

    // 2. Zod validation error
    if (error instanceof ZodError) {
      const issues = error.issues.map((i) => ({
        path: i.path.join("."),
        message: i.message,
      }));
      const envelope: ErrorEnvelope = {
        error: {
          code: ErrorCodes.VALIDATION_ERROR,
          message: "Request validation failed",
          details: { issues },
        },
      };
      return reply.status(400).send(envelope);
    }

    // Fastify schema validation error (if fastify validation was triggered)
    if ("validation" in error && Array.isArray((error as FastifyError).validation)) {
      const envelope: ErrorEnvelope = {
        error: {
          code: ErrorCodes.VALIDATION_ERROR,
          message: error.message,
          details: { issues: (error as FastifyError).validation },
        },
      };
      return reply.status(400).send(envelope);
    }

    // 3. PostgreSQL errors (defensive safety net)
    const pgErr = findPgError(error);
    if (pgErr?.code) {
      if (pgErr.code === "23505" && pgErr.constraint === "products_sku_key") {
        const envelope: ErrorEnvelope = {
          error: {
            code: ErrorCodes.SKU_ALREADY_EXISTS,
            message: "A product with this SKU already exists",
          },
        };
        return reply.status(409).send(envelope);
      }

      if (pgErr.code === "23514" && pgErr.constraint === "inventory_reserved_lte_on_hand_chk") {
        const envelope: ErrorEnvelope = {
          error: {
            code: ErrorCodes.STOCK_BELOW_RESERVED,
            message: "Cannot reduce inventory on hand below currently reserved quantity",
          },
        };
        return reply.status(409).send(envelope);
      }

      if (pgErr.code === "23514" && pgErr.constraint === "inventory_on_hand_non_negative_chk") {
        const envelope: ErrorEnvelope = {
          error: {
            code: ErrorCodes.NEGATIVE_STOCK,
            message: "Inventory quantity on hand cannot be negative",
          },
        };
        return reply.status(409).send(envelope);
      }

      if (pgErr.code === "22003") {
        const envelope: ErrorEnvelope = {
          error: {
            code: ErrorCodes.STOCK_LIMIT_EXCEEDED,
            message: "Stock value exceeds maximum allowed range",
          },
        };
        return reply.status(422).send(envelope);
      }
    }

    // 4. Default 500 Internal Server Error (never leak raw error messages to client)
    request.log.error(error);
    const envelope: ErrorEnvelope = {
      error: {
        code: ErrorCodes.INTERNAL_ERROR,
        message: "An internal server error occurred",
      },
    };
    return reply.status(500).send(envelope);
  });
}
