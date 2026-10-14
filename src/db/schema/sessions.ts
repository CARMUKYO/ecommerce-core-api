import { sql } from "drizzle-orm";
import { check, index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { users } from "./users.js";

/**
 * Opaque bearer-token sessions. Only the SHA-256 hash of the token is stored,
 * so a database leak yields no usable credentials. Logout deletes the row;
 * expiry is absolute (no sliding refresh).
 */
export const sessions = pgTable(
  "sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** Hex SHA-256 of the raw token. UNIQUE doubles as the lookup index. */
    tokenHash: text("token_hash").notNull().unique("sessions_token_hash_key"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    check("sessions_token_hash_format_chk", sql`${t.tokenHash} ~ '^[0-9a-f]{64}$'`),
    check("sessions_expiry_after_creation_chk", sql`${t.expiresAt} > ${t.createdAt}`),
    index("sessions_user_id_idx").on(t.userId),
    // Expired-session sweeper.
    index("sessions_expires_at_idx").on(t.expiresAt),
  ],
);

export type Session = typeof sessions.$inferSelect;
export type NewSession = typeof sessions.$inferInsert;
