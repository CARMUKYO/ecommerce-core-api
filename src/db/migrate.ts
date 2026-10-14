import { migrate } from "drizzle-orm/node-postgres/migrator";
import { closeDb, db } from "./client.js";
import { env } from "../config/env.js";

async function main(): Promise<void> {
  const target = new URL(env.DATABASE_URL);
  console.log(`Applying migrations to ${target.host}${target.pathname} ...`);
  await migrate(db, { migrationsFolder: "./drizzle" });
  console.log("Migrations applied.");
}

main()
  .catch((err: unknown) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => closeDb());
