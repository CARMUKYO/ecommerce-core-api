/**
 * Creates an ADMIN user. Admins can never be created through the public API.
 *
 *   ADMIN_EMAIL=ops@example.com ADMIN_PASSWORD='...' npm run seed:admin
 *
 * Credentials come from env vars rather than argv, which leaks into shell
 * history and `ps` output.
 */
import { closeDb, db } from "../db/client.js";
import { users } from "../db/schema/users.js";
import { RegisterSchema } from "../modules/auth/auth.schemas.js";
import { hashPassword } from "../modules/auth/credentials.js";

async function main(): Promise<void> {
  const parsed = RegisterSchema.safeParse({ email: process.env.ADMIN_EMAIL, password: process.env.ADMIN_PASSWORD });
  if (!parsed.success) {
    throw new Error(
      `Set ADMIN_EMAIL and ADMIN_PASSWORD (12-128 chars): ${parsed.error.issues.map((i) => i.message).join("; ")}`,
    );
  }

  const { email, password } = parsed.data;
  const [admin] = await db
    .insert(users)
    .values({ email, passwordHash: await hashPassword(password), role: "ADMIN" })
    .onConflictDoNothing({ target: users.email })
    .returning();

  if (!admin) {
    // Deliberately not promoting/resetting an existing account from a script.
    throw new Error(`A user with email ${email} already exists; refusing to modify it.`);
  }
  console.log(`Created ADMIN ${admin.email} (${admin.id})`);
}

main()
  .catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => closeDb());
