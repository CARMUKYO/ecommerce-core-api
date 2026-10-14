import { sql } from "drizzle-orm";
import { char, check, index, integer, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { productStatusEnum } from "./enums.js";

export const products = pgTable(
  "products",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sku: text("sku").notNull().unique("products_sku_key"),
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    /** Per-unit price in minor units (cents). Never a float. */
    priceCents: integer("price_cents").notNull(),
    currency: char("currency", { length: 3 }).notNull().default("USD"),
    status: productStatusEnum("status").notNull().default("DRAFT"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    // Prevents "sku-101" and "SKU-101" from coexisting.
    check("products_sku_format_chk", sql`${t.sku} = upper(${t.sku}) AND length(${t.sku}) BETWEEN 1 AND 64`),
    check("products_name_not_blank_chk", sql`length(btrim(${t.name})) > 0`),
    check("products_price_non_negative_chk", sql`${t.priceCents} >= 0`),
    check("products_currency_iso_chk", sql`${t.currency} ~ '^[A-Z]{3}$'`),
    index("products_status_idx").on(t.status),
  ],
);

export type Product = typeof products.$inferSelect;
export type NewProduct = typeof products.$inferInsert;
