import { pgEnum } from "drizzle-orm/pg-core";

export const userRoleEnum = pgEnum("user_role", ["CUSTOMER", "ADMIN"]);
export const userStatusEnum = pgEnum("user_status", ["ACTIVE", "SUSPENDED"]);

export const productStatusEnum = pgEnum("product_status", ["DRAFT", "ACTIVE", "ARCHIVED"]);

export const cartStatusEnum = pgEnum("cart_status", ["ACTIVE", "CONVERTED", "ABANDONED"]);

export const orderStatusEnum = pgEnum("order_status", ["PENDING", "PAID", "SHIPPED", "CANCELLED"]);

/**
 * Why a stock movement happened. Every change to `inventory` writes exactly one
 * append-only `inventory_movements` row with one of these reasons (decision D4).
 */
export const inventoryMovementReasonEnum = pgEnum("inventory_movement_reason", [
  "INITIAL_STOCK",
  "ADMIN_ADJUSTMENT",
  "ORDER_RESERVED", // checkout: reserved += q
  "ORDER_RELEASED", // cancel:   reserved -= q
  "ORDER_SHIPPED", //  ship:     on_hand -= q, reserved -= q
]);
