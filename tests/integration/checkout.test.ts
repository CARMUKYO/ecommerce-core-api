import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { db, pool } from "../../src/db/client.js";
import {
  cartItems,
  carts,
  inventory,
  inventoryMovements,
  orderItems,
  orders,
  products,
} from "../../src/db/schema/index.js";
import { createProduct, createUser } from "../helpers/fixtures.js";

describe("Phase 4: The Atomic Checkout & Order State Machine", () => {
  const app = buildApp();

  async function createCustomer() {
    return await createUser({ role: "CUSTOMER", status: "ACTIVE" });
  }

  describe("1. Concurrency: The 5-Way Checkout Oversell Test", () => {
    it("5 parallel checkouts competing for 2 units -> exactly 2 succeed (201) and 3 fail (409)", async () => {
      // 1. Setup product with ONLY 2 units available
      const product = await createProduct({ status: "ACTIVE", priceCents: 2000 }, { onHand: 2, reserved: 0 });

      // 2. Setup 5 distinct customers, each having 1 unit in their active cart
      const customers = await Promise.all(Array.from({ length: 5 }, () => createCustomer()));

      for (const customer of customers) {
        const addRes = await app.inject({
          method: "POST",
          url: "/cart/items",
          headers: { authorization: `Bearer ${customer.token}` },
          payload: { productId: product.id, quantity: 1 },
        });
        expect(addRes.statusCode).toBe(200);
      }

      // 3. Fire all 5 checkout requests simultaneously
      const checkoutRequests = customers.map((c) =>
        app.inject({
          method: "POST",
          url: "/checkout",
          headers: {
            authorization: `Bearer ${c.token}`,
            "idempotency-key": randomUUID(),
          },
        }),
      );

      const responses = await Promise.all(checkoutRequests);

      // 4. Assert exact success / failure counts
      const successes = responses.filter((r) => r.statusCode === 201);
      const conflicts = responses.filter((r) => r.statusCode === 409);

      expect(successes).toHaveLength(2);
      expect(conflicts).toHaveLength(3);

      for (const conf of conflicts) {
        const err = conf.json().error;
        expect(err.code).toBe("INSUFFICIENT_INVENTORY");
        expect(err.details).toMatchObject({
          sku: product.sku,
          requested: 1,
          available: 0,
        });
      }

      // 5. Verify database stock levels: quantity_reserved MUST equal 2, available MUST equal 0
      const [inv] = await db.select().from(inventory).where(eq(inventory.productId, product.id));
      expect(inv).toMatchObject({
        quantityOnHand: 2,
        quantityReserved: 2,
      });

      // 6. Verify exactly 2 Order records were created
      const allOrders = await db.select().from(orders);
      expect(allOrders).toHaveLength(2);

      // 7. Verify exactly 2 ORDER_RESERVED movements exist
      const movements = await db
        .select()
        .from(inventoryMovements)
        .where(eq(inventoryMovements.reason, "ORDER_RESERVED"));
      expect(movements).toHaveLength(2);
    });
  });

  describe("2. Deadlock Prevention Test (Multi-Item Concurrency)", () => {
    it("handles reverse-order cart items [P1, P2] vs [P2, P1] concurrently without deadlocking", async () => {
      const prodA = await createProduct({ status: "ACTIVE", priceCents: 1000 }, { onHand: 10, reserved: 0 });
      const prodB = await createProduct({ status: "ACTIVE", priceCents: 1500 }, { onHand: 10, reserved: 0 });

      const customer1 = await createCustomer();
      const customer2 = await createCustomer();

      // Customer 1 adds A then B
      await app.inject({
        method: "POST",
        url: "/cart/items",
        headers: { authorization: `Bearer ${customer1.token}` },
        payload: { productId: prodA.id, quantity: 2 },
      });
      await app.inject({
        method: "POST",
        url: "/cart/items",
        headers: { authorization: `Bearer ${customer1.token}` },
        payload: { productId: prodB.id, quantity: 2 },
      });

      // Customer 2 adds B then A (reverse order)
      await app.inject({
        method: "POST",
        url: "/cart/items",
        headers: { authorization: `Bearer ${customer2.token}` },
        payload: { productId: prodB.id, quantity: 2 },
      });
      await app.inject({
        method: "POST",
        url: "/cart/items",
        headers: { authorization: `Bearer ${customer2.token}` },
        payload: { productId: prodA.id, quantity: 2 },
      });

      // Fire both checkouts simultaneously
      const [res1, res2] = await Promise.all([
        app.inject({
          method: "POST",
          url: "/checkout",
          headers: { authorization: `Bearer ${customer1.token}`, "idempotency-key": randomUUID() },
        }),
        app.inject({
          method: "POST",
          url: "/checkout",
          headers: { authorization: `Bearer ${customer2.token}`, "idempotency-key": randomUUID() },
        }),
      ]);

      expect(res1.statusCode).toBe(201);
      expect(res2.statusCode).toBe(201);

      // Verify stock was reserved properly
      const [invA] = await db.select().from(inventory).where(eq(inventory.productId, prodA.id));
      const [invB] = await db.select().from(inventory).where(eq(inventory.productId, prodB.id));
      expect(invA?.quantityReserved).toBe(4);
      expect(invB?.quantityReserved).toBe(4);
    });
  });

  describe("3. Idempotency & Network Retry Safety", () => {
    it("returns replayed order on retry with the same key without double-reserving inventory", async () => {
      const customer = await createCustomer();
      const product = await createProduct({ status: "ACTIVE", priceCents: 2500 }, { onHand: 10, reserved: 0 });
      const idempotencyKey = randomUUID();

      await app.inject({
        method: "POST",
        url: "/cart/items",
        headers: { authorization: `Bearer ${customer.token}` },
        payload: { productId: product.id, quantity: 2 },
      });

      // First call -> 201
      const res1 = await app.inject({
        method: "POST",
        url: "/checkout",
        headers: { authorization: `Bearer ${customer.token}`, "idempotency-key": idempotencyKey },
      });
      expect(res1.statusCode).toBe(201);
      const order1 = res1.json().order;
      expect(res1.json().replayed).toBe(false);

      // Retry -> 200 OK (replayed)
      const res2 = await app.inject({
        method: "POST",
        url: "/checkout",
        headers: { authorization: `Bearer ${customer.token}`, "idempotency-key": idempotencyKey },
      });
      expect(res2.statusCode).toBe(200);
      const order2 = res2.json().order;
      expect(res2.json().replayed).toBe(true);
      expect(order2.id).toBe(order1.id);

      // Assert inventory was reserved only ONCE (2 units, NOT 4 units)
      const [inv] = await db.select().from(inventory).where(eq(inventory.productId, product.id));
      expect(inv?.quantityReserved).toBe(2);
    });

    it("5 concurrent requests with the identical user and idempotency key yield 1 order in database", async () => {
      const customer = await createCustomer();
      const product = await createProduct({ status: "ACTIVE" }, { onHand: 10, reserved: 0 });
      const key = randomUUID();

      await app.inject({
        method: "POST",
        url: "/cart/items",
        headers: { authorization: `Bearer ${customer.token}` },
        payload: { productId: product.id, quantity: 1 },
      });

      const responses = await Promise.all(
        Array.from({ length: 5 }, () =>
          app.inject({
            method: "POST",
            url: "/checkout",
            headers: { authorization: `Bearer ${customer.token}`, "idempotency-key": key },
          }),
        ),
      );

      // Exactly one creation; every other response is a replay (never a 500)
      expect(responses.filter((r) => r.statusCode === 201)).toHaveLength(1);
      expect(responses.filter((r) => r.statusCode === 200)).toHaveLength(4);
      expect(responses.filter((r) => r.statusCode === 200).every((r) => r.json().replayed === true)).toBe(true);

      // All should share the exact same order ID
      const orderIds = new Set(responses.map((r) => r.json().order.id));
      expect(orderIds.size).toBe(1);

      // Exactly 1 order in the database
      const dbOrders = await db.select().from(orders).where(eq(orders.userId, customer.id));
      expect(dbOrders).toHaveLength(1);
    });

    async function addAndCheckout(token: string, productId: string, quantity: number, key: string) {
      await app.inject({
        method: "POST",
        url: "/cart/items",
        headers: { authorization: `Bearer ${token}` },
        payload: { productId, quantity },
      });
      return app.inject({
        method: "POST",
        url: "/checkout",
        headers: { authorization: `Bearer ${token}`, "idempotency-key": key },
      });
    }

    it("replays the original order on a late retry even after the user started a new cart", async () => {
      const customer = await createCustomer();
      const p1 = await createProduct({ status: "ACTIVE" }, { onHand: 10 });
      const p2 = await createProduct({ status: "ACTIVE" }, { onHand: 10 });
      const key = randomUUID();

      const first = await addAndCheckout(customer.token, p1.id, 2, key);
      expect(first.statusCode).toBe(201);

      // User starts a new cart with different contents, then the delayed retry arrives
      await app.inject({
        method: "POST",
        url: "/cart/items",
        headers: { authorization: `Bearer ${customer.token}` },
        payload: { productId: p2.id, quantity: 3 },
      });
      const retry = await app.inject({
        method: "POST",
        url: "/checkout",
        headers: { authorization: `Bearer ${customer.token}`, "idempotency-key": key },
      });

      expect(retry.statusCode).toBe(200);
      expect(retry.json().replayed).toBe(true);
      expect(retry.json().order.id).toBe(first.json().order.id);

      // The new cart is untouched and nothing was reserved for it
      const cartRes = await app.inject({ method: "GET", url: "/cart", headers: { authorization: `Bearer ${customer.token}` } });
      expect(cartRes.json().items).toEqual([expect.objectContaining({ productId: p2.id, quantity: 3 })]);
      const [inv1] = await db.select().from(inventory).where(eq(inventory.productId, p1.id));
      const [inv2] = await db.select().from(inventory).where(eq(inventory.productId, p2.id));
      expect(inv1?.quantityReserved).toBe(2);
      expect(inv2?.quantityReserved).toBe(0);
      expect(await db.select().from(orders).where(eq(orders.userId, customer.id))).toHaveLength(1);
    });

    it("replays a since-cancelled order in its current status without re-purchasing", async () => {
      const customer = await createCustomer();
      const product = await createProduct({ status: "ACTIVE" }, { onHand: 10 });
      const key = randomUUID();

      const first = await addAndCheckout(customer.token, product.id, 2, key);
      const orderId = first.json().order.id;
      const cancel = await app.inject({
        method: "POST",
        url: `/orders/${orderId}/cancel`,
        headers: { authorization: `Bearer ${customer.token}` },
      });
      expect(cancel.statusCode).toBe(200);

      const retry = await app.inject({
        method: "POST",
        url: "/checkout",
        headers: { authorization: `Bearer ${customer.token}`, "idempotency-key": key },
      });
      expect(retry.statusCode).toBe(200);
      expect(retry.json()).toMatchObject({ replayed: true, order: { id: orderId, status: "CANCELLED" } });

      const [inv] = await db.select().from(inventory).where(eq(inventory.productId, product.id));
      expect(inv?.quantityReserved).toBe(0);
      expect(await db.select().from(orders).where(eq(orders.userId, customer.id))).toHaveLength(1);
    });

    it("scopes idempotency keys per user: the same key from two users creates two orders", async () => {
      const alice = await createCustomer();
      const bob = await createCustomer();
      const product = await createProduct({ status: "ACTIVE" }, { onHand: 10 });
      const sharedKey = "shared-key-123";

      const a = await addAndCheckout(alice.token, product.id, 1, sharedKey);
      const b = await addAndCheckout(bob.token, product.id, 1, sharedKey);

      expect(a.statusCode).toBe(201);
      expect(b.statusCode).toBe(201);
      expect(a.json().order.id).not.toBe(b.json().order.id);
      const [inv] = await db.select().from(inventory).where(eq(inventory.productId, product.id));
      expect(inv?.quantityReserved).toBe(2);
    });
  });

  describe("4. Order Cancellation & Double-Restock Prevention", () => {
    it("cancels a PENDING order and restores reserved inventory atomically", async () => {
      const customer = await createCustomer();
      const product = await createProduct({ status: "ACTIVE", priceCents: 1000 }, { onHand: 10, reserved: 0 });

      await app.inject({
        method: "POST",
        url: "/cart/items",
        headers: { authorization: `Bearer ${customer.token}` },
        payload: { productId: product.id, quantity: 4 },
      });

      const checkoutRes = await app.inject({
        method: "POST",
        url: "/checkout",
        headers: { authorization: `Bearer ${customer.token}`, "idempotency-key": randomUUID() },
      });
      const orderId = checkoutRes.json().order.id;

      // Verify stock was reserved: onHand: 10, reserved: 4
      const [invBefore] = await db.select().from(inventory).where(eq(inventory.productId, product.id));
      expect(invBefore?.quantityReserved).toBe(4);

      // Cancel order
      const cancelRes = await app.inject({
        method: "POST",
        url: `/orders/${orderId}/cancel`,
        headers: { authorization: `Bearer ${customer.token}` },
      });

      expect(cancelRes.statusCode).toBe(200);
      expect(cancelRes.json().order.status).toBe("CANCELLED");
      expect(cancelRes.json().alreadyCancelled).toBe(false);

      // Verify reserved inventory restored to 0
      const [invAfter] = await db.select().from(inventory).where(eq(inventory.productId, product.id));
      expect(invAfter?.quantityReserved).toBe(0);

      // Verify audit ledger row
      const [releaseMovement] = await db
        .select()
        .from(inventoryMovements)
        .where(eq(inventoryMovements.reason, "ORDER_RELEASED"));
      expect(releaseMovement).toMatchObject({
        orderId,
        deltaReserved: -4,
      });
    });

    it("concurrency: simultaneous cancel requests restore stock exactly once (no double-restock)", async () => {
      const customer = await createCustomer();
      const product = await createProduct({ status: "ACTIVE" }, { onHand: 10, reserved: 0 });

      await app.inject({
        method: "POST",
        url: "/cart/items",
        headers: { authorization: `Bearer ${customer.token}` },
        payload: { productId: product.id, quantity: 3 },
      });

      const checkoutRes = await app.inject({
        method: "POST",
        url: "/checkout",
        headers: { authorization: `Bearer ${customer.token}`, "idempotency-key": randomUUID() },
      });
      const orderId = checkoutRes.json().order.id;

      // Fire 2 concurrent cancel requests
      const [res1, res2] = await Promise.all([
        app.inject({
          method: "POST",
          url: `/orders/${orderId}/cancel`,
          headers: { authorization: `Bearer ${customer.token}` },
        }),
        app.inject({
          method: "POST",
          url: `/orders/${orderId}/cancel`,
          headers: { authorization: `Bearer ${customer.token}` },
        }),
      ]);

      expect(res1.statusCode).toBe(200);
      expect(res2.statusCode).toBe(200);

      const cancelFlags = [res1.json().alreadyCancelled, res2.json().alreadyCancelled];
      expect(cancelFlags).toContain(false);
      expect(cancelFlags).toContain(true);

      // Check DB stock: reserved must be 0 (NOT negative -3)
      const [inv] = await db.select().from(inventory).where(eq(inventory.productId, product.id));
      expect(inv?.quantityReserved).toBe(0);

      // Exactly ONE ORDER_RELEASED movement
      const releaseMovements = await db
        .select()
        .from(inventoryMovements)
        .where(eq(inventoryMovements.reason, "ORDER_RELEASED"));
      expect(releaseMovements).toHaveLength(1);
    });

    it("rejects cancelling a SHIPPED order with 409 INVALID_ORDER_STATE_TRANSITION", async () => {
      const customer = await createCustomer();
      const product = await createProduct({ status: "ACTIVE" }, { onHand: 5 });

      await app.inject({
        method: "POST",
        url: "/cart/items",
        headers: { authorization: `Bearer ${customer.token}` },
        payload: { productId: product.id, quantity: 1 },
      });

      const checkoutRes = await app.inject({
        method: "POST",
        url: "/checkout",
        headers: { authorization: `Bearer ${customer.token}`, "idempotency-key": randomUUID() },
      });
      const orderId = checkoutRes.json().order.id;

      // Transition order directly to SHIPPED in DB (paidAt is required by orders_paid_at_consistency_chk)
      const now = new Date();
      await db
        .update(orders)
        .set({ status: "SHIPPED", paidAt: now, shippedAt: now })
        .where(eq(orders.id, orderId));

      const res = await app.inject({
        method: "POST",
        url: `/orders/${orderId}/cancel`,
        headers: { authorization: `Bearer ${customer.token}` },
      });

      expect(res.statusCode).toBe(409);
      expect(res.json().error.code).toBe("INVALID_ORDER_STATE_TRANSITION");
    });
  });

  describe("5. Historical Price Snapshot Integrity", () => {
    it("ensures historical order item prices and details are completely immune to live product mutations", async () => {
      const customer = await createCustomer();
      const product = await createProduct(
        { status: "ACTIVE", priceCents: 1999, name: "Original Vintage Watch", sku: "WATCH-VINTAGE-01" },
        { onHand: 10 },
      );

      await app.inject({
        method: "POST",
        url: "/cart/items",
        headers: { authorization: `Bearer ${customer.token}` },
        payload: { productId: product.id, quantity: 2 },
      });

      const checkoutRes = await app.inject({
        method: "POST",
        url: "/checkout",
        headers: { authorization: `Bearer ${customer.token}`, "idempotency-key": randomUUID() },
      });
      const orderId = checkoutRes.json().order.id;

      // Live product is renamed, price doubled, and status changed to ARCHIVED
      await db
        .update(products)
        .set({
          name: "Super Modern Watch",
          priceCents: 4999,
          status: "ARCHIVED",
        })
        .where(eq(products.id, product.id));

      // Query order via GET /orders/:id
      const res = await app.inject({
        method: "GET",
        url: `/orders/${orderId}`,
        headers: { authorization: `Bearer ${customer.token}` },
      });

      expect(res.statusCode).toBe(200);
      const { order } = res.json();
      expect(order.totalCents).toBe(3998); // 2 * 1999
      expect(order.items[0]).toMatchObject({
        sku: "WATCH-VINTAGE-01",
        productName: "Original Vintage Watch",
        unitPriceCents: 1999,
        lineTotalCents: 3998,
        quantity: 2,
      });

      // Verify DB order_items table row directly
      const [orderItem] = await db.select().from(orderItems).where(eq(orderItems.orderId, orderId));
      expect(orderItem?.productNameSnapshot).toBe("Original Vintage Watch");
      expect(orderItem?.unitPriceCentsSnapshot).toBe(1999);
      expect(orderItem?.lineTotalCents).toBe(3998);
    });
  });

  describe("6. Cart Lifecycle & Empty Cart Validation", () => {
    it("rejects checkout with 400 CART_EMPTY when active cart has no items", async () => {
      const customer = await createCustomer();

      const res = await app.inject({
        method: "POST",
        url: "/checkout",
        headers: { authorization: `Bearer ${customer.token}`, "idempotency-key": randomUUID() },
      });

      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe("CART_EMPTY");
    });

    it("converts cart status to CONVERTED, and subsequent GET /cart provides a fresh ACTIVE cart", async () => {
      const customer = await createCustomer();
      const product = await createProduct({ status: "ACTIVE" }, { onHand: 10 });

      await app.inject({
        method: "POST",
        url: "/cart/items",
        headers: { authorization: `Bearer ${customer.token}` },
        payload: { productId: product.id, quantity: 1 },
      });

      const initialCartRes = await app.inject({
        method: "GET",
        url: "/cart",
        headers: { authorization: `Bearer ${customer.token}` },
      });
      const originalCartId = initialCartRes.json().id;

      // Checkout
      await app.inject({
        method: "POST",
        url: "/checkout",
        headers: { authorization: `Bearer ${customer.token}`, "idempotency-key": randomUUID() },
      });

      // Original cart must be CONVERTED in DB
      const [origCart] = await db.select().from(carts).where(eq(carts.id, originalCartId));
      expect(origCart?.status).toBe("CONVERTED");

      // Next GET /cart generates a fresh ACTIVE empty cart
      const nextCartRes = await app.inject({
        method: "GET",
        url: "/cart",
        headers: { authorization: `Bearer ${customer.token}` },
      });
      expect(nextCartRes.statusCode).toBe(200);
      expect(nextCartRes.json().id).not.toBe(originalCartId);
      expect(nextCartRes.json().items).toHaveLength(0);
    });
  });

  describe("7. Cart Locking: Checkout vs Concurrent Cart Writes", () => {
    /**
     * Deterministic interleaving: hold the inventory row lock from a separate
     * connection so checkout pauses *after* it has locked the cart, then fire a
     * competing request while checkout is mid-transaction.
     */
    async function holdInventoryLock(productId: string) {
      const client = await pool.connect();
      await client.query("BEGIN");
      await client.query("SELECT 1 FROM inventory WHERE product_id = $1 FOR UPDATE", [productId]);
      return async () => {
        await client.query("COMMIT");
        client.release();
      };
    }

    /** Wait until `n` backends are blocked on row locks. */
    async function waitForLockWaiters(n: number) {
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline) {
        const { rows } = await pool.query(
          "SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'",
        );
        if (rows[0].n >= n) return;
        await new Promise((r) => setTimeout(r, 20));
      }
      throw new Error(`Timed out waiting for ${n} lock waiter(s)`);
    }

    /** INVARIANT: every CONVERTED cart's items exactly match its order's items. */
    async function expectConvertedCartsMatchOrders(userId: string) {
      const convertedCarts = await db.select().from(carts).where(eq(carts.userId, userId));
      for (const cart of convertedCarts.filter((c) => c.status === "CONVERTED")) {
        const [order] = await db.select().from(orders).where(eq(orders.cartId, cart.id));
        expect(order).toBeDefined();
        const items = await db.select().from(cartItems).where(eq(cartItems.cartId, cart.id));
        const ordered = await db.select().from(orderItems).where(eq(orderItems.orderId, order!.id));
        const asSet = (rows: { productId: string; quantity: number }[]) =>
          rows.map((r) => `${r.productId}:${r.quantity}`).sort();
        expect(asSet(items)).toEqual(asSet(ordered));
      }
    }

    async function addToCart(token: string, productId: string, quantity: number) {
      const res = await app.inject({
        method: "POST",
        url: "/cart/items",
        headers: { authorization: `Bearer ${token}` },
        payload: { productId, quantity },
      });
      expect(res.statusCode).toBe(200);
      return res;
    }

    function checkout(token: string, key: string = randomUUID()) {
      return app.inject({
        method: "POST",
        url: "/checkout",
        headers: { authorization: `Bearer ${token}`, "idempotency-key": key },
      });
    }

    it("add-to-cart during checkout lands in the fresh cart, never in the converted one", async () => {
      const customer = await createCustomer();
      const p1 = await createProduct({ status: "ACTIVE", priceCents: 1000 }, { onHand: 10 });
      const p2 = await createProduct({ status: "ACTIVE", priceCents: 500 }, { onHand: 10 });
      await addToCart(customer.token, p1.id, 1);

      const release = await holdInventoryLock(p1.id);
      const checkoutP = checkout(customer.token);
      await waitForLockWaiters(1);
      const addP = app.inject({
        method: "POST",
        url: "/cart/items",
        headers: { authorization: `Bearer ${customer.token}` },
        payload: { productId: p2.id, quantity: 2 },
      });
      await waitForLockWaiters(2);
      await release();

      const [checkoutRes, addRes] = await Promise.all([checkoutP, addP]);
      expect(checkoutRes.statusCode).toBe(201);
      const order = checkoutRes.json().order;
      expect(order.items).toHaveLength(1);
      expect(order.items[0]).toMatchObject({ productId: p1.id, quantity: 1 });
      expect(order.totalCents).toBe(1000);

      // The add was serialized after the purchase: it lives in the new ACTIVE cart
      expect(addRes.statusCode).toBe(200);
      expect(addRes.json().id).not.toBe(order.cartId);
      expect(addRes.json().items).toEqual([expect.objectContaining({ productId: p2.id, quantity: 2 })]);

      await expectConvertedCartsMatchOrders(customer.id);
    });

    it("PATCH quantity during checkout returns 404 and the order keeps the original quantity", async () => {
      const customer = await createCustomer();
      const product = await createProduct({ status: "ACTIVE" }, { onHand: 10 });
      await addToCart(customer.token, product.id, 1);

      const release = await holdInventoryLock(product.id);
      const checkoutP = checkout(customer.token);
      await waitForLockWaiters(1);
      const patchP = app.inject({
        method: "PATCH",
        url: `/cart/items/${product.id}`,
        headers: { authorization: `Bearer ${customer.token}` },
        payload: { quantity: 5 },
      });
      await waitForLockWaiters(2);
      await release();

      const [checkoutRes, patchRes] = await Promise.all([checkoutP, patchP]);
      expect(checkoutRes.statusCode).toBe(201);
      expect(checkoutRes.json().order.items[0].quantity).toBe(1);
      expect(patchRes.statusCode).toBe(404);
      expect(patchRes.json().error.code).toBe("CART_ITEM_NOT_FOUND");

      const [inv] = await db.select().from(inventory).where(eq(inventory.productId, product.id));
      expect(inv?.quantityReserved).toBe(1);
      await expectConvertedCartsMatchOrders(customer.id);
    });

    it("DELETE item during checkout applies to the fresh cart and does not mutate the purchased cart", async () => {
      const customer = await createCustomer();
      const product = await createProduct({ status: "ACTIVE" }, { onHand: 10 });
      await addToCart(customer.token, product.id, 2);

      const release = await holdInventoryLock(product.id);
      const checkoutP = checkout(customer.token);
      await waitForLockWaiters(1);
      const deleteP = app.inject({
        method: "DELETE",
        url: `/cart/items/${product.id}`,
        headers: { authorization: `Bearer ${customer.token}` },
      });
      await waitForLockWaiters(2);
      await release();

      const [checkoutRes, deleteRes] = await Promise.all([checkoutP, deleteP]);
      expect(checkoutRes.statusCode).toBe(201);
      const order = checkoutRes.json().order;
      expect(order.items[0]).toMatchObject({ productId: product.id, quantity: 2 });

      // The response honestly reflects the user's new (empty) cart
      expect(deleteRes.statusCode).toBe(200);
      expect(deleteRes.json().id).not.toBe(order.cartId);
      expect(deleteRes.json().items).toHaveLength(0);

      await expectConvertedCartsMatchOrders(customer.id);
    });

    it("two checkouts with different keys: one 201, the other 409 CART_ALREADY_CHECKED_OUT", async () => {
      const customer = await createCustomer();
      const product = await createProduct({ status: "ACTIVE" }, { onHand: 10 });
      await addToCart(customer.token, product.id, 3);

      const release = await holdInventoryLock(product.id);
      const firstP = checkout(customer.token, "key-A");
      await waitForLockWaiters(1);
      const secondP = checkout(customer.token, "key-B");
      await waitForLockWaiters(2);
      await release();

      const [first, second] = await Promise.all([firstP, secondP]);
      expect(first.statusCode).toBe(201);
      expect(second.statusCode).toBe(409);
      expect(second.json().error).toMatchObject({
        code: "CART_ALREADY_CHECKED_OUT",
        details: { cartId: first.json().order.cartId, orderId: first.json().order.id },
      });

      const dbOrders = await db.select().from(orders).where(eq(orders.userId, customer.id));
      expect(dbOrders).toHaveLength(1);
      const [inv] = await db.select().from(inventory).where(eq(inventory.productId, product.id));
      expect(inv?.quantityReserved).toBe(3);
    });

    it("5 parallel checkouts with different keys never 500: exactly one 201, the rest 409", async () => {
      const customer = await createCustomer();
      const product = await createProduct({ status: "ACTIVE" }, { onHand: 10 });
      await addToCart(customer.token, product.id, 1);

      const responses = await Promise.all(Array.from({ length: 5 }, () => checkout(customer.token)));

      expect(responses.filter((r) => r.statusCode === 201)).toHaveLength(1);
      const rest = responses.filter((r) => r.statusCode !== 201);
      // A request that starts after the winner commits sees no ACTIVE cart -> CART_EMPTY
      for (const r of rest) {
        expect([400, 409]).toContain(r.statusCode);
        expect(["CART_ALREADY_CHECKED_OUT", "CART_EMPTY"]).toContain(r.json().error.code);
      }

      const [inv] = await db.select().from(inventory).where(eq(inventory.productId, product.id));
      expect(inv?.quantityReserved).toBe(1);
    });

    it("a failed checkout leaves the cart ACTIVE and intact, and releases the lock", async () => {
      const customer = await createCustomer();
      const scarce = await createProduct({ status: "ACTIVE" }, { onHand: 5 });
      const other = await createProduct({ status: "ACTIVE" }, { onHand: 10 });
      await addToCart(customer.token, scarce.id, 5);
      // Stock drops after the item was added to the cart
      await db.update(inventory).set({ quantityReserved: 4 }).where(eq(inventory.productId, scarce.id));

      const res = await checkout(customer.token);
      expect(res.statusCode).toBe(409);
      expect(res.json().error.code).toBe("INSUFFICIENT_INVENTORY");

      const [cart] = await db.select().from(carts).where(eq(carts.userId, customer.id));
      expect(cart?.status).toBe("ACTIVE");
      const items = await db.select().from(cartItems).where(eq(cartItems.cartId, cart!.id));
      expect(items).toEqual([expect.objectContaining({ productId: scarce.id, quantity: 5 })]);

      // Lock was released: a subsequent write to the same cart goes through
      const addRes = await addToCart(customer.token, other.id, 1);
      expect(addRes.json().id).toBe(cart!.id);
    });
  });
});
