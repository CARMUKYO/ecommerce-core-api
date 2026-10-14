import { sql } from "drizzle-orm";
import { check, index, integer, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { inventoryMovementReasonEnum } from "./enums.js";
import { orders } from "./orders.js";
import { products } from "./products.js";
import { users } from "./users.js";

/**
 * Stock levels, 1:1 with products (decision D7). Created in the same
 * transaction as its product.
 *
 * Semantics (decision D2 — reserve, then commit):
 *   quantity_on_hand   = physical units in the warehouse
 *   quantity_reserved  = units promised to PENDING/PAID orders, not yet shipped
 *   available          = on_hand - reserved   (never < 0)
 */
export const inventory = pgTable(
  "inventory",
  {
    productId: uuid("product_id")
      .primaryKey()
      .references(() => products.id, { onDelete: "cascade" }),
    quantityOnHand: integer("quantity_on_hand").notNull().default(0),
    quantityReserved: integer("quantity_reserved").notNull().default(0),
    /** Optimistic concurrency token; incremented on every write. */
    version: integer("version").notNull().default(0),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    check("inventory_on_hand_non_negative_chk", sql`${t.quantityOnHand} >= 0`),
    check("inventory_reserved_non_negative_chk", sql`${t.quantityReserved} >= 0`),
    // CORE INVARIANT: available stock can never be negative.
    check("inventory_reserved_lte_on_hand_chk", sql`${t.quantityReserved} <= ${t.quantityOnHand}`),
  ],
);

/**
 * Append-only audit ledger (decision D4). Every inventory mutation writes one
 * row in the same transaction, so stock can be reconstructed/reconciled:
 *   SUM(delta_on_hand)  == inventory.quantity_on_hand
 *   SUM(delta_reserved) == inventory.quantity_reserved
 */
export const inventoryMovements = pgTable(
  "inventory_movements",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    productId: uuid("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "restrict" }),
    deltaOnHand: integer("delta_on_hand").notNull().default(0),
    deltaReserved: integer("delta_reserved").notNull().default(0),
    reason: inventoryMovementReasonEnum("reason").notNull(),
    orderId: uuid("order_id").references(() => orders.id, { onDelete: "restrict" }),
    actorUserId: uuid("actor_user_id").references(() => users.id, { onDelete: "restrict" }),
    note: text("note"),
    idempotencyKey: text("idempotency_key"),
    requestFingerprint: text("request_fingerprint"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check("inventory_movements_non_zero_chk", sql`${t.deltaOnHand} <> 0 OR ${t.deltaReserved} <> 0`),
    // Order-driven movements must reference their order.
    check(
      "inventory_movements_order_ref_chk",
      sql`${t.reason} NOT IN ('ORDER_RESERVED', 'ORDER_RELEASED', 'ORDER_SHIPPED') OR ${t.orderId} IS NOT NULL`,
    ),
    uniqueIndex("inventory_movements_product_idempotency_uidx")
      .on(t.productId, t.idempotencyKey)
      .where(sql`${t.idempotencyKey} IS NOT NULL`),
    index("inventory_movements_product_created_at_idx").on(t.productId, t.createdAt),
    index("inventory_movements_order_id_idx").on(t.orderId),
  ],
);

export type Inventory = typeof inventory.$inferSelect;
export type NewInventory = typeof inventory.$inferInsert;
export type InventoryMovement = typeof inventoryMovements.$inferSelect;
export type NewInventoryMovement = typeof inventoryMovements.$inferInsert;
