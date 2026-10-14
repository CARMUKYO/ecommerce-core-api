export const ErrorCodes = {
  // 400 Bad Request
  VALIDATION_ERROR: "VALIDATION_ERROR",
  IDEMPOTENCY_KEY_REQUIRED: "IDEMPOTENCY_KEY_REQUIRED",

  // 401 Unauthorized
  UNAUTHENTICATED: "UNAUTHENTICATED",

  // 403 Forbidden
  FORBIDDEN: "FORBIDDEN",
  ACCOUNT_SUSPENDED: "ACCOUNT_SUSPENDED",

  // 404 Not Found
  PRODUCT_NOT_FOUND: "PRODUCT_NOT_FOUND",

  // 409 Conflict
  SKU_ALREADY_EXISTS: "SKU_ALREADY_EXISTS",
  SKU_IMMUTABLE: "SKU_IMMUTABLE",
  PRODUCT_NOT_EDITABLE: "PRODUCT_NOT_EDITABLE",
  INVALID_PRODUCT_STATUS_TRANSITION: "INVALID_PRODUCT_STATUS_TRANSITION",
  NEGATIVE_STOCK: "NEGATIVE_STOCK",
  STOCK_BELOW_RESERVED: "STOCK_BELOW_RESERVED",
  INSUFFICIENT_INVENTORY: "INSUFFICIENT_INVENTORY",

  // 422 Unprocessable Entity
  PRODUCT_NOT_ACTIVATABLE: "PRODUCT_NOT_ACTIVATABLE",
  STOCK_LIMIT_EXCEEDED: "STOCK_LIMIT_EXCEEDED",
  IDEMPOTENCY_KEY_REUSED: "IDEMPOTENCY_KEY_REUSED",

  // 500 Internal Server Error
  INTERNAL_ERROR: "INTERNAL_ERROR",
} as const;

export type ErrorCode = (typeof ErrorCodes)[keyof typeof ErrorCodes];

export interface ErrorEnvelope {
  error: {
    code: ErrorCode;
    message: string;
    details?: Record<string, unknown> | undefined;
  };
}

export class AppError extends Error {
  public readonly statusCode: number;
  public readonly code: ErrorCode;
  public readonly details?: Record<string, unknown> | undefined;

  constructor(opts: { statusCode: number; code: ErrorCode; message: string; details?: Record<string, unknown> }) {
    super(opts.message);
    this.name = "AppError";
    this.statusCode = opts.statusCode;
    this.code = opts.code;
    if (opts.details !== undefined) {
      this.details = opts.details;
    }
    Object.setPrototypeOf(this, new.target.prototype);
  }
}
