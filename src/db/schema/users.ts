import { sql } from "drizzle-orm";
import { check, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { userRoleEnum, userStatusEnum } from "./enums.js";

export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // Stored normalized to lowercase. The CHECK guarantees the UNIQUE index is
    // effectively case-insensitive without needing the citext extension.
    email: text("email").notNull().unique("users_email_key"),
    passwordHash: text("password_hash").notNull(),
    role: userRoleEnum("role").notNull().default("CUSTOMER"),
    status: userStatusEnum("status").notNull().default("ACTIVE"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    check("users_email_lowercase_chk", sql`${t.email} = lower(${t.email})`),
    check("users_email_format_chk", sql`${t.email} ~ '^[^@\\s]+@[^@\\s]+$'`),
  ],
);

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
