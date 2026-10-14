import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { db } from "../../src/db/client.js";
import {
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
          headers: { authorization: `Bearer ${customer.id}` },
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
            authorization: `Bearer ${c.id}`,
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
        headers: { authorization: `Bearer ${customer1.id}` },
        payload: { productId: prodA.id, quantity: 2 },
      });
      await app.inject({
        method: "POST",
        url: "/cart/items",
        headers: { authorization: `Bearer ${customer1.id}` },
        payload: { productId: prodB.id, quantity: 2 },
      });

      // Customer 2 adds B then A (reverse order)
      await app.inject({
        method: "POST",
        url: "/cart/items",
        headers: { authorization: `Bearer ${customer2.id}` },
        payload: { productId: prodB.id, quantity: 2 },
      });
      await app.inject({
        method: "POST",
        url: "/cart/items",
        headers: { authorization: `Bearer ${customer2.id}` },
        payload: { productId: prodA.id, quantity: 2 },
      });

      // Fire both checkouts simultaneously
      const [res1, res2] = await Promise.all([
        app.inject({
          method: "POST",
          url: "/checkout",
          headers: { authorization: `Bearer ${customer1.id}`, "idempotency-key": randomUUID() },
        }),
        app.inject({
          method: "POST",
          url: "/checkout",
          headers: { authorization: `Bearer ${customer2.id}`, "idempotency-key": randomUUID() },
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
        headers: { authorization: `Bearer ${customer.id}` },
        payload: { productId: product.id, quantity: 2 },
      });

      // First call -> 201
      const res1 = await app.inject({
        method: "POST",
        url: "/checkout",
        headers: { authorization: `Bearer ${customer.id}`, "idempotency-key": idempotencyKey },
      });
      expect(res1.statusCode).toBe(201);
      const order1 = res1.json().order;
      expect(res1.json().replayed).toBe(false);

      // Retry -> 200 OK (replayed)
      const res2 = await app.inject({
        method: "POST",
        url: "/checkout",
        headers: { authorization: `Bearer ${customer.id}`, "idempotency-key": idempotencyKey },
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
        headers: { authorization: `Bearer ${customer.id}` },
        payload: { productId: product.id, quantity: 1 },
      });

      const responses = await Promise.all(
        Array.from({ length: 5 }, () =>
          app.inject({
            method: "POST",
            url: "/checkout",
            headers: { authorization: `Bearer ${customer.id}`, "idempotency-key": key },
          }),
        ),
      );

      // All responses should be successful (200 or 201)
      expect(responses.every((r) => r.statusCode === 200 || r.statusCode === 201)).toBe(true);

      // All should share the exact same order ID
      const orderIds = new Set(responses.map((r) => r.json().order.id));
      expect(orderIds.size).toBe(1);

      // Exactly 1 order in the database
      const dbOrders = await db.select().from(orders).where(eq(orders.userId, customer.id));
      expect(dbOrders).toHaveLength(1);
    });
  });

  describe("4. Order Cancellation & Double-Restock Prevention", () => {
    it("cancels a PENDING order and restores reserved inventory atomically", async () => {
      const customer = await createCustomer();
      const product = await createProduct({ status: "ACTIVE", priceCents: 1000 }, { onHand: 10, reserved: 0 });

      await app.inject({
        method: "POST",
        url: "/cart/items",
        headers: { authorization: `Bearer ${customer.id}` },
        payload: { productId: product.id, quantity: 4 },
      });

      const checkoutRes = await app.inject({
        method: "POST",
        url: "/checkout",
        headers: { authorization: `Bearer ${customer.id}`, "idempotency-key": randomUUID() },
      });
      const orderId = checkoutRes.json().order.id;

      // Verify stock was reserved: onHand: 10, reserved: 4
      const [invBefore] = await db.select().from(inventory).where(eq(inventory.productId, product.id));
      expect(invBefore?.quantityReserved).toBe(4);

      // Cancel order
      const cancelRes = await app.inject({
        method: "POST",
        url: `/orders/${orderId}/cancel`,
        headers: { authorization: `Bearer ${customer.id}` },
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
        headers: { authorization: `Bearer ${customer.id}` },
        payload: { productId: product.id, quantity: 3 },
      });

      const checkoutRes = await app.inject({
        method: "POST",
        url: "/checkout",
        headers: { authorization: `Bearer ${customer.id}`, "idempotency-key": randomUUID() },
      });
      const orderId = checkoutRes.json().order.id;

      // Fire 2 concurrent cancel requests
      const [res1, res2] = await Promise.all([
        app.inject({
          method: "POST",
          url: `/orders/${orderId}/cancel`,
          headers: { authorization: `Bearer ${customer.id}` },
        }),
        app.inject({
          method: "POST",
          url: `/orders/${orderId}/cancel`,
          headers: { authorization: `Bearer ${customer.id}` },
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
        headers: { authorization: `Bearer ${customer.id}` },
        payload: { productId: product.id, quantity: 1 },
      });

      const checkoutRes = await app.inject({
        method: "POST",
        url: "/checkout",
        headers: { authorization: `Bearer ${customer.id}`, "idempotency-key": randomUUID() },
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
        headers: { authorization: `Bearer ${customer.id}` },
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
        headers: { authorization: `Bearer ${customer.id}` },
        payload: { productId: product.id, quantity: 2 },
      });

      const checkoutRes = await app.inject({
        method: "POST",
        url: "/checkout",
        headers: { authorization: `Bearer ${customer.id}`, "idempotency-key": randomUUID() },
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
        headers: { authorization: `Bearer ${customer.id}` },
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
        headers: { authorization: `Bearer ${customer.id}`, "idempotency-key": randomUUID() },
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
        headers: { authorization: `Bearer ${customer.id}` },
        payload: { productId: product.id, quantity: 1 },
      });

      const initialCartRes = await app.inject({
        method: "GET",
        url: "/cart",
        headers: { authorization: `Bearer ${customer.id}` },
      });
      const originalCartId = initialCartRes.json().id;

      // Checkout
      await app.inject({
        method: "POST",
        url: "/checkout",
        headers: { authorization: `Bearer ${customer.id}`, "idempotency-key": randomUUID() },
      });

      // Original cart must be CONVERTED in DB
      const [origCart] = await db.select().from(carts).where(eq(carts.id, originalCartId));
      expect(origCart?.status).toBe("CONVERTED");

      // Next GET /cart generates a fresh ACTIVE empty cart
      const nextCartRes = await app.inject({
        method: "GET",
        url: "/cart",
        headers: { authorization: `Bearer ${customer.id}` },
      });
      expect(nextCartRes.statusCode).toBe(200);
      expect(nextCartRes.json().id).not.toBe(originalCartId);
      expect(nextCartRes.json().items).toHaveLength(0);
    });
  });
});
