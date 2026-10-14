import { and, eq, gt, sql } from "drizzle-orm";
import type { DbExecutor } from "../../db/client.js";
import { sessions, type Session } from "../../db/schema/sessions.js";
import { users, type User } from "../../db/schema/users.js";

export class AuthRepository {
  async findUserByEmail(executor: DbExecutor, email: string): Promise<User | undefined> {
    const [row] = await executor.select().from(users).where(eq(users.email, email));
    return row;
  }

  async createCustomer(executor: DbExecutor, email: string, passwordHash: string): Promise<User> {
    // Role is hard-coded: self-registration can never create an ADMIN.
    const [row] = await executor.insert(users).values({ email, passwordHash, role: "CUSTOMER" }).returning();
    return row!;
  }

  async createSession(executor: DbExecutor, userId: string, tokenHash: string, expiresAt: Date): Promise<Session> {
    const [row] = await executor.insert(sessions).values({ userId, tokenHash, expiresAt }).returning();
    return row!;
  }

  /** Unexpired session + its user, by token hash. Expiry is checked against the DB clock. */
  async findLiveSessionWithUser(
    executor: DbExecutor,
    tokenHash: string,
  ): Promise<{ session: Session; user: User } | undefined> {
    const [row] = await executor
      .select({ session: sessions, user: users })
      .from(sessions)
      .innerJoin(users, eq(sessions.userId, users.id))
      .where(and(eq(sessions.tokenHash, tokenHash), gt(sessions.expiresAt, sql`now()`)));
    return row;
  }

  async deleteSession(executor: DbExecutor, sessionId: string): Promise<void> {
    await executor.delete(sessions).where(eq(sessions.id, sessionId));
  }
}

export const authRepository = new AuthRepository();
