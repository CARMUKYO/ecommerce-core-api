import { afterAll, beforeEach } from "vitest";
import { closeDb, pool } from "../src/db/client.js";

const TABLES = [
  "inventory_movements",
  "order_items",
  "orders",
  "cart_items",
  "carts",
  "inventory",
  "products",
  "users",
];

beforeEach(async () => {
  await pool.query(`TRUNCATE ${TABLES.map((t) => `"${t}"`).join(", ")} RESTART IDENTITY CASCADE`);
});

afterAll(async () => {
  await closeDb();
});
