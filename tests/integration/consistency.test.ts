import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { db } from "../../src/db/client.js";
import { products } from "../../src/db/schema/index.js";
import { createProduct, createUser, type TestUser } from "../helpers/fixtures.js";
import { holdInTransaction, waitForLockWaiters } from "../helpers/locks.js";

describe("Consistency under concurrent admin edits & pagination", () => {
  const app = buildApp();
  const auth = (u: TestUser) => ({ authorization: `Bearer ${u.token}` });

  async function addToCart(customer: TestUser, productId: string, quantity: number) {
    const res = await app.inject({ method: "POST", url: "/cart/items", headers: auth(customer), payload: { productId, quantity } });
    expect(res.statusCode).toBe(200);
  }

  const checkout = (customer: TestUser) =>
    app.inject({ method: "POST", url: "/checkout", headers: { ...auth(customer), "idempotency-key": randomUUID() } });

  describe("Checkout vs concurrent product edits (shared product locks)", () => {
    it("an archive committed mid-checkout is seen: 409 PRODUCT_UNAVAILABLE, no order", async () => {
      const customer = await createUser();
      const product = await createProduct({ status: "ACTIVE" }, { onHand: 10 });
      await addToCart(customer, product.id, 1);

      // Admin archive in progress (row locked, not yet committed)
      const archive = await holdInTransaction("UPDATE products SET status = 'ARCHIVED' WHERE id = $1", [product.id]);
      const checkoutP = checkout(customer);
      await waitForLockWaiters(1);
      await archive.commit();

      const res = await checkoutP;
      expect(res.statusCode).toBe(409);
      expect(res.json().error.code).toBe("PRODUCT_UNAVAILABLE");
    });

    it("a price edit committed mid-checkout is snapshotted at its committed value", async () => {
      const customer = await createUser();
      const product = await createProduct({ status: "ACTIVE", priceCents: 1000 }, { onHand: 10 });
      await addToCart(customer, product.id, 2);

      const edit = await holdInTransaction("UPDATE products SET price_cents = 1500 WHERE id = $1", [product.id]);
      const checkoutP = checkout(customer);
      await waitForLockWaiters(1);
      await edit.commit();

      const res = await checkoutP;
      expect(res.statusCode).toBe(201);
      expect(res.json().order.items[0].unitPriceCents).toBe(1500);
      expect(res.json().order.totalCents).toBe(3000);
    });

    it("an archive requested mid-checkout waits for the checkout to commit", async () => {
      const admin = await createUser({ role: "ADMIN" });
      const customer = await createUser();
      const product = await createProduct({ status: "ACTIVE" }, { onHand: 10 });
      await addToCart(customer, product.id, 1);

      // Pause checkout after it took its product share lock (blocked on inventory)
      const inv = await holdInTransaction("SELECT 1 FROM inventory WHERE product_id = $1 FOR UPDATE", [product.id]);
      const checkoutP = checkout(customer);
      await waitForLockWaiters(1);
      const archiveP = app.inject({ method: "POST", url: `/admin/products/${product.id}/archive`, headers: auth(admin) });
      await waitForLockWaiters(2);
      await inv.commit();

      const [checkoutRes, archiveRes] = await Promise.all([checkoutP, archiveP]);
      expect(checkoutRes.statusCode).toBe(201);
      expect(archiveRes.statusCode).toBe(200);
      expect(archiveRes.json().product.status).toBe("ARCHIVED");
    });
  });

  describe("Product edits are checked under the row lock", () => {
    it("activation cannot race a price-to-zero edit into an ACTIVE product priced at 0", async () => {
      const admin = await createUser({ role: "ADMIN" });
      const product = await createProduct({ status: "DRAFT", priceCents: 1000 });

      const edit = await holdInTransaction("UPDATE products SET price_cents = 0 WHERE id = $1", [product.id]);
      const activateP = app.inject({ method: "POST", url: `/admin/products/${product.id}/activate`, headers: auth(admin) });
      await waitForLockWaiters(1);
      await edit.commit();

      const res = await activateP;
      expect(res.statusCode).toBe(422);
      expect(res.json().error.code).toBe("PRODUCT_NOT_ACTIVATABLE");
      const [row] = await db.select().from(products).where(eq(products.id, product.id));
      expect(row).toMatchObject({ status: "DRAFT", priceCents: 0 });
    });

    it("a SKU edit cannot land on a product activated concurrently (409 SKU_IMMUTABLE)", async () => {
      const admin = await createUser({ role: "ADMIN" });
      const product = await createProduct({ status: "DRAFT", priceCents: 1000 });

      const activation = await holdInTransaction("UPDATE products SET status = 'ACTIVE' WHERE id = $1", [product.id]);
      const patchP = app.inject({
        method: "PATCH",
        url: `/admin/products/${product.id}`,
        headers: auth(admin),
        payload: { sku: "NEW-SKU-1" },
      });
      await waitForLockWaiters(1);
      await activation.commit();

      const res = await patchP;
      expect(res.statusCode).toBe(409);
      expect(res.json().error.code).toBe("SKU_IMMUTABLE");
      const [row] = await db.select().from(products).where(eq(products.id, product.id));
      expect(row!.sku).toBe(product.sku);
    });
  });

  describe("Pagination", () => {
    it("lists orders with correct per-order items, real totals, and stable non-overlapping pages", async () => {
      const customer = await createUser();
      const placed: string[] = [];
      for (let i = 1; i <= 5; i++) {
        const product = await createProduct({ status: "ACTIVE" }, { onHand: 10 });
        await addToCart(customer, product.id, i);
        placed.push((await checkout(customer)).json().order.id);
      }

      const seen: string[] = [];
      for (const offset of [0, 2, 4]) {
        const res = await app.inject({ method: "GET", url: `/orders?limit=2&offset=${offset}`, headers: auth(customer) });
        expect(res.json().total).toBe(5);
        for (const order of res.json().orders) {
          seen.push(order.id);
          // Each order carries exactly its own single line
          expect(order.items).toHaveLength(1);
          expect(order.items[0].quantity).toBe(placed.indexOf(order.id) + 1);
        }
      }
      expect(seen).toHaveLength(5);
      expect(new Set(seen)).toEqual(new Set(placed));
      expect(seen).toEqual([...placed].reverse()); // newest first
    });

    it("pages inventory movements written in one transaction without duplicates", async () => {
      const admin = await createUser({ role: "ADMIN" });
      const customer = await createUser();
      const product = await createProduct({ status: "ACTIVE" }, { onHand: 10 });
      await addToCart(customer, product.id, 1);
      const order = (await checkout(customer)).json().order;
      await app.inject({ method: "POST", url: `/orders/${order.id}/cancel`, headers: auth(customer) });

      const ids: string[] = [];
      for (let offset = 0; offset < 3; offset++) {
        const res = await app.inject({
          method: "GET",
          url: `/admin/products/${product.id}/inventory/movements?limit=1&offset=${offset}`,
          headers: auth(admin),
        });
        expect(res.json().total).toBe(3);
        ids.push(res.json().items[0].id);
      }
      expect(new Set(ids).size).toBe(3);
    });
  });
});
