import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { ZodError } from "zod";
import { findPgError, PgErrorCodes } from "../db/pg-errors.js";
import { AppError, ErrorCodes, type ErrorCode, type ErrorEnvelope } from "./errors.js";

const MALFORMED_BODY_CODES = new Set([
  "FST_ERR_CTP_INVALID_JSON_BODY",
  "FST_ERR_CTP_EMPTY_JSON_BODY",
  "FST_ERR_CTP_INVALID_CONTENT_LENGTH",
]);

function mapFastifyClientError(
  error: FastifyError | Error,
): { statusCode: number; code: ErrorCode; message: string } | undefined {
  const { statusCode, code } = error as Partial<FastifyError>;
  if (typeof statusCode !== "number" || statusCode < 400 || statusCode >= 500) return undefined;

  if (code && MALFORMED_BODY_CODES.has(code)) {
    return { statusCode: 400, code: ErrorCodes.MALFORMED_REQUEST_BODY, message: "Request body is malformed or empty" };
  }
  if (code === "FST_ERR_CTP_BODY_TOO_LARGE") {
    return { statusCode: 413, code: ErrorCodes.PAYLOAD_TOO_LARGE, message: "Request body is too large" };
  }
  if (code === "FST_ERR_CTP_INVALID_MEDIA_TYPE") {
    return { statusCode: 415, code: ErrorCodes.UNSUPPORTED_MEDIA_TYPE, message: "Unsupported content type" };
  }
  return { statusCode, code: ErrorCodes.BAD_REQUEST, message: "The request could not be processed" };
}

export function registerNotFoundHandler(app: FastifyInstance): void {
  app.setNotFoundHandler((_request: FastifyRequest, reply: FastifyReply) => {
    const envelope: ErrorEnvelope = {
      error: { code: ErrorCodes.ROUTE_NOT_FOUND, message: "The requested route does not exist" },
    };
    return reply.status(404).send(envelope);
  });
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

    // Fastify's own client errors (body parsing, content type, size limits).
    // Fixed messages only: parser output can echo fragments of the request.
    const clientError = mapFastifyClientError(error);
    if (clientError) {
      request.log.info({ err: error }, "client error");
      const envelope: ErrorEnvelope = {
        error: { code: clientError.code, message: clientError.message },
      };
      return reply.status(clientError.statusCode).send(envelope);
    }

    // 3. PostgreSQL errors (defensive safety net)
    const pgErr = findPgError(error);
    if (pgErr?.code) {
      if (pgErr.code === PgErrorCodes.UNIQUE_VIOLATION && pgErr.constraint === "products_sku_key") {
        const envelope: ErrorEnvelope = {
          error: {
            code: ErrorCodes.SKU_ALREADY_EXISTS,
            message: "A product with this SKU already exists",
          },
        };
        return reply.status(409).send(envelope);
      }

      if (pgErr.code === PgErrorCodes.CHECK_VIOLATION && pgErr.constraint === "inventory_reserved_lte_on_hand_chk") {
        const envelope: ErrorEnvelope = {
          error: {
            code: ErrorCodes.STOCK_BELOW_RESERVED,
            message: "Cannot reduce inventory on hand below currently reserved quantity",
          },
        };
        return reply.status(409).send(envelope);
      }

      if (pgErr.code === PgErrorCodes.CHECK_VIOLATION && pgErr.constraint === "inventory_on_hand_non_negative_chk") {
        const envelope: ErrorEnvelope = {
          error: {
            code: ErrorCodes.NEGATIVE_STOCK,
            message: "Inventory quantity on hand cannot be negative",
          },
        };
        return reply.status(409).send(envelope);
      }

      // lock_timeout / statement_timeout: transient contention, safe to retry.
      if (pgErr.code === PgErrorCodes.LOCK_NOT_AVAILABLE || pgErr.code === PgErrorCodes.QUERY_CANCELED) {
        request.log.warn({ err: error }, "database timeout");
        const envelope: ErrorEnvelope = {
          error: {
            code: ErrorCodes.SERVICE_BUSY,
            message: "The service is busy; please retry shortly",
          },
        };
        return reply.status(503).header("retry-after", "1").send(envelope);
      }

      if (pgErr.code === PgErrorCodes.NUMERIC_OUT_OF_RANGE) {
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
