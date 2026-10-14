import { sql } from "drizzle-orm";
import {
  bigint,
  char,
  check,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { carts } from "./carts.js";
import { orderStatusEnum } from "./enums.js";
import { products } from "./products.js";
import { users } from "./users.js";

export const orders = pgTable(
  "orders",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    // UNIQUE: a cart converts into at most one order (second, independent
    // guard against duplicate checkout alongside the idempotency key).
    cartId: uuid("cart_id")
      .notNull()
      .unique("orders_cart_id_key")
      .references(() => carts.id, { onDelete: "restrict" }),
    idempotencyKey: text("idempotency_key").notNull(),
    /** Hash of the checkout payload; detects key reuse with a different request. */
    requestFingerprint: text("request_fingerprint").notNull(),
    status: orderStatusEnum("status").notNull().default("PENDING"),
    /** BIGINT so qty x price aggregates can never overflow. */
    totalCents: bigint("total_cents", { mode: "number" }).notNull(),
    currency: char("currency", { length: 3 }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
    paidAt: timestamp("paid_at", { withTimezone: true }),
    shippedAt: timestamp("shipped_at", { withTimezone: true }),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
  },
  (t) => [
    // Per-user idempotency scope (decision D3).
    uniqueIndex("orders_user_idempotency_key_uidx").on(t.userId, t.idempotencyKey),
    check("orders_idempotency_key_length_chk", sql`length(${t.idempotencyKey}) BETWEEN 1 AND 255`),
    check("orders_total_non_negative_chk", sql`${t.totalCents} >= 0`),
    check("orders_currency_iso_chk", sql`${t.currency} ~ '^[A-Z]{3}$'`),
    // Status <-> lifecycle timestamp consistency.
    check("orders_cancelled_at_consistency_chk", sql`(${t.status} = 'CANCELLED') = (${t.cancelledAt} IS NOT NULL)`),
    check("orders_shipped_at_consistency_chk", sql`(${t.status} = 'SHIPPED') = (${t.shippedAt} IS NOT NULL)`),
    check(
      "orders_paid_at_consistency_chk",
      sql`(${t.status} NOT IN ('PAID', 'SHIPPED') OR ${t.paidAt} IS NOT NULL) AND (${t.status} <> 'PENDING' OR ${t.paidAt} IS NULL)`,
    ),
    index("orders_user_created_at_idx").on(t.userId, t.createdAt.desc()),
    index("orders_status_created_at_idx").on(t.status, t.createdAt),
  ],
);

export const orderItems = pgTable(
  "order_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orderId: uuid("order_id")
      .notNull()
      .references(() => orders.id, { onDelete: "restrict" }),
    // RESTRICT: a product with order history can never be hard-deleted.
    // This FK is for integrity/analytics only — never for rendering prices.
    productId: uuid("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "restrict" }),
    quantity: integer("quantity").notNull(),
    // Immutable snapshots taken at checkout time.
    unitPriceCentsSnapshot: integer("unit_price_cents_snapshot").notNull(),
    productNameSnapshot: text("product_name_snapshot").notNull(),
    skuSnapshot: text("sku_snapshot").notNull(),
    lineTotalCents: bigint("line_total_cents", { mode: "number" }).notNull(),
  },
  (t) => [
    uniqueIndex("order_items_order_product_uidx").on(t.orderId, t.productId),
    check("order_items_quantity_positive_chk", sql`${t.quantity} >= 1`),
    check("order_items_unit_price_non_negative_chk", sql`${t.unitPriceCentsSnapshot} >= 0`),
    check(
      "order_items_line_total_chk",
      sql`${t.lineTotalCents} = ${t.quantity}::bigint * ${t.unitPriceCentsSnapshot}`,
    ),
    index("order_items_product_id_idx").on(t.productId),
  ],
);

export type Order = typeof orders.$inferSelect;
export type NewOrder = typeof orders.$inferInsert;
export type OrderItem = typeof orderItems.$inferSelect;
export type NewOrderItem = typeof orderItems.$inferInsert;
