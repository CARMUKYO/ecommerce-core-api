import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { db, pool } from "../../src/db/client.js";
import { inventory, inventoryMovements, orders } from "../../src/db/schema/index.js";
import { orderService } from "../../src/modules/orders/order.service.js";
import { createProduct, createUser, type TestUser } from "../helpers/fixtures.js";

describe("Order Lifecycle: payment, shipping, cancellation policy & expiry", () => {
  const app = buildApp();

  const auth = (u: TestUser) => ({ authorization: `Bearer ${u.token}` });

  async function placeOrder(customer: TestUser, productId: string, quantity: number) {
    await app.inject({ method: "POST", url: "/cart/items", headers: auth(customer), payload: { productId, quantity } });
    const res = await app.inject({
      method: "POST",
      url: "/checkout",
      headers: { ...auth(customer), "idempotency-key": randomUUID() },
    });
    expect(res.statusCode).toBe(201);
    return res.json().order as { id: string; status: string };
  }

  const post = (u: TestUser, url: string) => app.inject({ method: "POST", url, headers: auth(u) });

  async function stock(productId: string) {
    const [inv] = await db.select().from(inventory).where(eq(inventory.productId, productId));
    return { onHand: inv!.quantityOnHand, reserved: inv!.quantityReserved };
  }

  /** INVARIANT (ledger): movements sum to the current stock levels. */
  async function expectLedgerBalanced(productId: string) {
    const [sums] = await db
      .select({
        onHand: sql<number>`coalesce(sum(${inventoryMovements.deltaOnHand}), 0)::int`,
        reserved: sql<number>`coalesce(sum(${inventoryMovements.deltaReserved}), 0)::int`,
      })
      .from(inventoryMovements)
      .where(eq(inventoryMovements.productId, productId));
    expect(sums).toEqual(await stock(productId));
  }

  /** Backdate an order so it is past the PENDING TTL. */
  async function backdate(orderId: string, minutes: number) {
    await db
      .update(orders)
      .set({ createdAt: new Date(Date.now() - minutes * 60_000) })
      .where(eq(orders.id, orderId));
  }

  describe("Pay & ship (admin)", () => {
    it("PENDING -> PAID -> SHIPPED moves stock correctly and keeps the ledger balanced", async () => {
      const admin = await createUser({ role: "ADMIN" });
      const customer = await createUser();
      const product = await createProduct({ status: "ACTIVE" }, { onHand: 10 });
      const order = await placeOrder(customer, product.id, 3);
      expect(await stock(product.id)).toEqual({ onHand: 10, reserved: 3 });

      const paid = await post(admin, `/admin/orders/${order.id}/mark-paid`);
      expect(paid.statusCode).toBe(200);
      expect(paid.json()).toMatchObject({ alreadyPaid: false, order: { status: "PAID" } });
      expect(paid.json().order.paidAt).not.toBeNull();
      // Paying does not touch stock: units stay reserved until they ship
      expect(await stock(product.id)).toEqual({ onHand: 10, reserved: 3 });

      const shipped = await post(admin, `/admin/orders/${order.id}/ship`);
      expect(shipped.statusCode).toBe(200);
      expect(shipped.json()).toMatchObject({ alreadyShipped: false, order: { status: "SHIPPED" } });
      expect(shipped.json().order.shippedAt).not.toBeNull();
      expect(await stock(product.id)).toEqual({ onHand: 7, reserved: 0 });

      const movements = await db
        .select()
        .from(inventoryMovements)
        .where(eq(inventoryMovements.orderId, order.id));
      expect(movements.map((m) => [m.reason, m.deltaOnHand, m.deltaReserved])).toEqual(
        expect.arrayContaining([
          ["ORDER_RESERVED", 0, 3],
          ["ORDER_SHIPPED", -3, -3],
        ]),
      );
      await expectLedgerBalanced(product.id);
    });

    it("repeating mark-paid / ship is an idempotent no-op", async () => {
      const admin = await createUser({ role: "ADMIN" });
      const product = await createProduct({ status: "ACTIVE" }, { onHand: 10 });
      const order = await placeOrder(await createUser(), product.id, 2);

      await post(admin, `/admin/orders/${order.id}/mark-paid`);
      const again = await post(admin, `/admin/orders/${order.id}/mark-paid`);
      expect(again.json()).toMatchObject({ alreadyPaid: true, order: { status: "PAID" } });

      await post(admin, `/admin/orders/${order.id}/ship`);
      const shipAgain = await post(admin, `/admin/orders/${order.id}/ship`);
      expect(shipAgain.json()).toMatchObject({ alreadyShipped: true, order: { status: "SHIPPED" } });
      expect(await stock(product.id)).toEqual({ onHand: 8, reserved: 0 });
    });

    it.each([
      ["ship a PENDING order", "PENDING", "ship"],
      ["mark a CANCELLED order paid", "CANCELLED", "mark-paid"],
      ["ship a CANCELLED order", "CANCELLED", "ship"],
      ["mark a SHIPPED order paid", "SHIPPED", "mark-paid"],
    ])("rejects attempts to %s with 409 INVALID_ORDER_STATE_TRANSITION", async (_label, state, action) => {
      const admin = await createUser({ role: "ADMIN" });
      const product = await createProduct({ status: "ACTIVE" }, { onHand: 10 });
      const order = await placeOrder(await createUser(), product.id, 1);
      if (state === "CANCELLED") await post(admin, `/orders/${order.id}/cancel`);
      if (state === "SHIPPED") {
        await post(admin, `/admin/orders/${order.id}/mark-paid`);
        await post(admin, `/admin/orders/${order.id}/ship`);
      }
      const before = await stock(product.id);

      const res = await post(admin, `/admin/orders/${order.id}/${action}`);
      expect(res.statusCode).toBe(409);
      expect(res.json().error).toMatchObject({ code: "INVALID_ORDER_STATE_TRANSITION", details: { from: state } });
      expect(await stock(product.id)).toEqual(before);
    });

    it("pay, ship and the admin order list are admin-only (403 for customers)", async () => {
      const customer = await createUser();
      const product = await createProduct({ status: "ACTIVE" }, { onHand: 10 });
      const order = await placeOrder(customer, product.id, 1);

      for (const res of [
        await post(customer, `/admin/orders/${order.id}/mark-paid`),
        await post(customer, `/admin/orders/${order.id}/ship`),
        await app.inject({ method: "GET", url: "/admin/orders", headers: auth(customer) }),
      ]) {
        expect(res.statusCode).toBe(403);
        expect(res.json().error.code).toBe("FORBIDDEN");
      }
    });

    it("admin order list spans users and filters by status", async () => {
      const admin = await createUser({ role: "ADMIN" });
      const product = await createProduct({ status: "ACTIVE" }, { onHand: 20 });
      const a = await placeOrder(await createUser(), product.id, 1);
      const b = await placeOrder(await createUser(), product.id, 2);
      await post(admin, `/admin/orders/${b.id}/mark-paid`);

      const all = await app.inject({ method: "GET", url: "/admin/orders", headers: auth(admin) });
      expect(all.json().total).toBe(2);

      const paid = await app.inject({ method: "GET", url: "/admin/orders?status=PAID", headers: auth(admin) });
      expect(paid.json().total).toBe(1);
      expect(paid.json().orders[0]).toMatchObject({ id: b.id, items: [expect.objectContaining({ quantity: 2 })] });
      expect(paid.json().orders.some((o: { id: string }) => o.id === a.id)).toBe(false);
    });
  });

  describe("#8 Cancellation policy", () => {
    it("a customer cannot cancel their PAID order (403), and stock stays reserved", async () => {
      const admin = await createUser({ role: "ADMIN" });
      const customer = await createUser();
      const product = await createProduct({ status: "ACTIVE" }, { onHand: 10 });
      const order = await placeOrder(customer, product.id, 2);
      await post(admin, `/admin/orders/${order.id}/mark-paid`);

      const res = await post(customer, `/orders/${order.id}/cancel`);
      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe("CANCELLATION_REQUIRES_ADMIN");
      expect(await stock(product.id)).toEqual({ onHand: 10, reserved: 2 });
    });

    it("an admin can cancel a PAID order, releasing stock", async () => {
      const admin = await createUser({ role: "ADMIN" });
      const product = await createProduct({ status: "ACTIVE" }, { onHand: 10 });
      const order = await placeOrder(await createUser(), product.id, 2);
      await post(admin, `/admin/orders/${order.id}/mark-paid`);

      const res = await post(admin, `/orders/${order.id}/cancel`);
      expect(res.statusCode).toBe(200);
      expect(res.json().order.status).toBe("CANCELLED");
      expect(await stock(product.id)).toEqual({ onHand: 10, reserved: 0 });
      await expectLedgerBalanced(product.id);
    });

    it("a customer can still cancel their own PENDING order", async () => {
      const customer = await createUser();
      const product = await createProduct({ status: "ACTIVE" }, { onHand: 10 });
      const order = await placeOrder(customer, product.id, 2);

      const res = await post(customer, `/orders/${order.id}/cancel`);
      expect(res.statusCode).toBe(200);
      expect(await stock(product.id)).toEqual({ onHand: 10, reserved: 0 });
    });
  });

  describe("Unpaid PENDING order expiry job", () => {
    it("cancels only PENDING orders past the TTL and releases their stock exactly once", async () => {
      const admin = await createUser({ role: "ADMIN" });
      const product = await createProduct({ status: "ACTIVE" }, { onHand: 10 });
      const stale = await placeOrder(await createUser(), product.id, 2);
      const fresh = await placeOrder(await createUser(), product.id, 3);
      const stalePaid = await placeOrder(await createUser(), product.id, 1);
      await post(admin, `/admin/orders/${stalePaid.id}/mark-paid`);
      await backdate(stale.id, 31);
      await backdate(stalePaid.id, 31);

      expect(await orderService.expirePendingOrders({ ttlMinutes: 30 })).toBe(1);
      // Second run finds nothing: no double release
      expect(await orderService.expirePendingOrders({ ttlMinutes: 30 })).toBe(0);

      const statusOf = async (id: string) =>
        (await db.select().from(orders).where(eq(orders.id, id)))[0]!.status;
      expect(await statusOf(stale.id)).toBe("CANCELLED");
      expect(await statusOf(fresh.id)).toBe("PENDING");
      expect(await statusOf(stalePaid.id)).toBe("PAID");
      expect(await stock(product.id)).toEqual({ onHand: 10, reserved: 4 });

      const [release] = await db
        .select()
        .from(inventoryMovements)
        .where(sql`${inventoryMovements.orderId} = ${stale.id} AND ${inventoryMovements.reason} = 'ORDER_RELEASED'`);
      expect(release).toMatchObject({ deltaReserved: -2, actorUserId: null });
      expect(release!.note).toContain("Expired");
      await expectLedgerBalanced(product.id);
    });

    it("a payment racing the expiry job wins cleanly when it locks the order first", async () => {
      const product = await createProduct({ status: "ACTIVE" }, { onHand: 10 });
      const order = await placeOrder(await createUser(), product.id, 2);
      await backdate(order.id, 31);

      // Payment holds the order row lock while the job tries to expire it
      const blocker = await pool.connect();
      await blocker.query("BEGIN");
      await blocker.query("SELECT 1 FROM orders WHERE id = $1 FOR UPDATE", [order.id]);
      const jobP = orderService.expirePendingOrders({ ttlMinutes: 30 });
      await new Promise((r) => setTimeout(r, 200));
      await blocker.query("UPDATE orders SET status = 'PAID', paid_at = now() WHERE id = $1", [order.id]);
      await blocker.query("COMMIT");
      blocker.release();

      expect(await jobP).toBe(0);
      const [row] = await db.select().from(orders).where(eq(orders.id, order.id));
      expect(row!.status).toBe("PAID");
      expect(await stock(product.id)).toEqual({ onHand: 10, reserved: 2 });
    });

    it("concurrent expiry runs and a customer cancel release stock exactly once", async () => {
      const customer = await createUser();
      const product = await createProduct({ status: "ACTIVE" }, { onHand: 10 });
      const order = await placeOrder(customer, product.id, 4);
      await backdate(order.id, 31);

      const results = await Promise.all([
        orderService.expirePendingOrders({ ttlMinutes: 30 }),
        orderService.expirePendingOrders({ ttlMinutes: 30 }),
        post(customer, `/orders/${order.id}/cancel`),
      ]);
      const expiredCount = (results[0] as number) + (results[1] as number);
      expect(expiredCount).toBeLessThanOrEqual(1);

      expect(await stock(product.id)).toEqual({ onHand: 10, reserved: 0 });
      const releases = await db
        .select()
        .from(inventoryMovements)
        .where(sql`${inventoryMovements.orderId} = ${order.id} AND ${inventoryMovements.reason} = 'ORDER_RELEASED'`);
      expect(releases).toHaveLength(1);
      await expectLedgerBalanced(product.id);
    });
  });
});
