export const ErrorCodes = {
  // 400 Bad Request
  VALIDATION_ERROR: "VALIDATION_ERROR",
  IDEMPOTENCY_KEY_REQUIRED: "IDEMPOTENCY_KEY_REQUIRED",
  CART_EMPTY: "CART_EMPTY",
  MALFORMED_REQUEST_BODY: "MALFORMED_REQUEST_BODY",
  BAD_REQUEST: "BAD_REQUEST",

  // 401 Unauthorized
  UNAUTHENTICATED: "UNAUTHENTICATED",
  INVALID_CREDENTIALS: "INVALID_CREDENTIALS",

  // 403 Forbidden
  FORBIDDEN: "FORBIDDEN",
  ACCOUNT_SUSPENDED: "ACCOUNT_SUSPENDED",
  CANCELLATION_REQUIRES_ADMIN: "CANCELLATION_REQUIRES_ADMIN",

  // 404 Not Found
  PRODUCT_NOT_FOUND: "PRODUCT_NOT_FOUND",
  CART_ITEM_NOT_FOUND: "CART_ITEM_NOT_FOUND",
  ORDER_NOT_FOUND: "ORDER_NOT_FOUND",
  ROUTE_NOT_FOUND: "ROUTE_NOT_FOUND",

  // 409 Conflict
  SKU_ALREADY_EXISTS: "SKU_ALREADY_EXISTS",
  EMAIL_ALREADY_REGISTERED: "EMAIL_ALREADY_REGISTERED",
  SKU_IMMUTABLE: "SKU_IMMUTABLE",
  PRODUCT_NOT_EDITABLE: "PRODUCT_NOT_EDITABLE",
  INVALID_PRODUCT_STATUS_TRANSITION: "INVALID_PRODUCT_STATUS_TRANSITION",
  INVALID_ORDER_STATE_TRANSITION: "INVALID_ORDER_STATE_TRANSITION",
  NEGATIVE_STOCK: "NEGATIVE_STOCK",
  STOCK_BELOW_RESERVED: "STOCK_BELOW_RESERVED",
  INSUFFICIENT_INVENTORY: "INSUFFICIENT_INVENTORY",
  PRODUCT_UNAVAILABLE: "PRODUCT_UNAVAILABLE",
  CART_ITEM_QUANTITY_EXCEEDED: "CART_ITEM_QUANTITY_EXCEEDED",
  CART_LIMIT_EXCEEDED: "CART_LIMIT_EXCEEDED",
  CART_ALREADY_CHECKED_OUT: "CART_ALREADY_CHECKED_OUT",

  // 413 Payload Too Large
  PAYLOAD_TOO_LARGE: "PAYLOAD_TOO_LARGE",

  // 415 Unsupported Media Type
  UNSUPPORTED_MEDIA_TYPE: "UNSUPPORTED_MEDIA_TYPE",

  // 422 Unprocessable Entity
  PRODUCT_NOT_ACTIVATABLE: "PRODUCT_NOT_ACTIVATABLE",
  STOCK_LIMIT_EXCEEDED: "STOCK_LIMIT_EXCEEDED",
  IDEMPOTENCY_KEY_REUSED: "IDEMPOTENCY_KEY_REUSED",

  // 429 Too Many Requests
  RATE_LIMITED: "RATE_LIMITED",

  // 500 Internal Server Error
  INTERNAL_ERROR: "INTERNAL_ERROR",

  // 503 Service Unavailable
  SERVICE_BUSY: "SERVICE_BUSY",
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
