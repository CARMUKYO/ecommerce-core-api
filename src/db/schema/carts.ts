import { sql } from "drizzle-orm";
import { check, index, integer, pgTable, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { cartStatusEnum } from "./enums.js";
import { products } from "./products.js";
import { users } from "./users.js";

/**
 * Hard safety ceiling for a single cart line. The *business* max (default 99)
 * is configurable and enforced in the service layer; this only guards against
 * runaway values if application validation is ever bypassed.
 */
export const CART_ITEM_QUANTITY_HARD_CEILING = 999;

export const carts = pgTable(
  "carts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    status: cartStatusEnum("status").notNull().default("ACTIVE"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    // INVARIANT: a user has at most one ACTIVE cart. Partial unique index makes
    // this race-safe — concurrent "create cart" requests cannot both succeed.
    uniqueIndex("carts_one_active_per_user_uidx").on(t.userId).where(sql`${t.status} = 'ACTIVE'`),
    index("carts_user_id_idx").on(t.userId),
    // Abandoned-cart sweeper.
    index("carts_status_updated_at_idx").on(t.status, t.updatedAt),
  ],
);

export const cartItems = pgTable(
  "cart_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    cartId: uuid("cart_id")
      .notNull()
      .references(() => carts.id, { onDelete: "cascade" }),
    productId: uuid("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "restrict" }),
    quantity: integer("quantity").notNull(),
    addedAt: timestamp("added_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    // INVARIANT: one line per product per cart. Enables atomic
    // INSERT ... ON CONFLICT (cart_id, product_id) DO UPDATE upserts.
    uniqueIndex("cart_items_cart_product_uidx").on(t.cartId, t.productId),
    check(
      "cart_items_quantity_bounds_chk",
      sql`${t.quantity} >= 1 AND ${t.quantity} <= ${sql.raw(String(CART_ITEM_QUANTITY_HARD_CEILING))}`,
    ),
    // Postgres does not auto-index FK columns; needed for RESTRICT checks and
    // "which carts contain product X" lookups.
    index("cart_items_product_id_idx").on(t.productId),
  ],
);

export type Cart = typeof carts.$inferSelect;
export type NewCart = typeof carts.$inferInsert;
export type CartItem = typeof cartItems.$inferSelect;
export type NewCartItem = typeof cartItems.$inferInsert;
