import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { db } from "../../src/db/client.js";
import { inventory, inventoryMovements } from "../../src/db/schema/index.js";
import { createProduct, createUser } from "../helpers/fixtures.js";

describe("Inventory API Integration", () => {
  const app = buildApp();

  async function createAdmin() {
    return await createUser({ role: "ADMIN", status: "ACTIVE" });
  }

  describe("POST /admin/products/:id/inventory/adjustments", () => {
    it("successfully applies +10 adjustment and appends to movement ledger", async () => {
      const admin = await createAdmin();
      const product = await createProduct({}, { onHand: 20, reserved: 5 });
      const idempotencyKey = randomUUID();

      const res = await app.inject({
        method: "POST",
        url: `/admin/products/${product.id}/inventory/adjustments`,
        headers: {
          authorization: `Bearer ${admin.id}`,
          "idempotency-key": idempotencyKey,
        },
        payload: {
          delta: 10,
          note: "Restock from shipment #402",
        },
      });

      expect(res.statusCode).toBe(200);
      const data = res.json();
      expect(data.replayed).toBe(false);
      expect(data.inventory).toMatchObject({
        quantityOnHand: 30,
        quantityReserved: 5,
        availableQuantity: 25,
        version: 1,
      });

      // Check movement ledger
      const [movement] = await db
        .select()
        .from(inventoryMovements)
        .where(eq(inventoryMovements.idempotencyKey, idempotencyKey));
      expect(movement).toMatchObject({
        productId: product.id,
        deltaOnHand: 10,
        deltaReserved: 0,
        reason: "ADMIN_ADJUSTMENT",
        actorUserId: admin.id,
        note: "Restock from shipment #402",
      });
    });

    it("rejects reducing stock below currently reserved quantities with 409 STOCK_BELOW_RESERVED", async () => {
      const admin = await createAdmin();
      const product = await createProduct({}, { onHand: 10, reserved: 7 });

      const res = await app.inject({
        method: "POST",
        url: `/admin/products/${product.id}/inventory/adjustments`,
        headers: {
          authorization: `Bearer ${admin.id}`,
          "idempotency-key": randomUUID(),
        },
        payload: {
          delta: -5,
          note: "Damaged inventory write-off",
        },
      });

      expect(res.statusCode).toBe(409);
      const err = res.json().error;
      expect(err.code).toBe("STOCK_BELOW_RESERVED");
      expect(err.details).toMatchObject({
        onHand: 10,
        reserved: 7,
        requestedDelta: -5,
        maxDecrease: 3,
      });

      // Verify inventory was not modified
      const [inv] = await db.select().from(inventory).where(eq(inventory.productId, product.id));
      expect(inv?.quantityOnHand).toBe(10);
    });

    it("allows reducing stock to exactly the reserved quantity (available = 0)", async () => {
      const admin = await createAdmin();
      const product = await createProduct({}, { onHand: 10, reserved: 7 });

      const res = await app.inject({
        method: "POST",
        url: `/admin/products/${product.id}/inventory/adjustments`,
        headers: {
          authorization: `Bearer ${admin.id}`,
          "idempotency-key": randomUUID(),
        },
        payload: {
          delta: -3,
          note: "Write off unreserved items",
        },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().inventory).toMatchObject({
        quantityOnHand: 7,
        quantityReserved: 7,
        availableQuantity: 0,
        inStock: false,
      });
    });

    it("rejects adjustments that would cause on_hand to be negative with 409 NEGATIVE_STOCK", async () => {
      const admin = await createAdmin();
      const product = await createProduct({}, { onHand: 2, reserved: 0 });

      const res = await app.inject({
        method: "POST",
        url: `/admin/products/${product.id}/inventory/adjustments`,
        headers: {
          authorization: `Bearer ${admin.id}`,
          "idempotency-key": randomUUID(),
        },
        payload: {
          delta: -5,
          note: "Remove items",
        },
      });

      expect(res.statusCode).toBe(409);
      expect(res.json().error.code).toBe("NEGATIVE_STOCK");
    });

    it("rejects adjustments exceeding upper bounds with 422 STOCK_LIMIT_EXCEEDED", async () => {
      const admin = await createAdmin();
      const product = await createProduct({}, { onHand: 999_990, reserved: 0 });

      const res = await app.inject({
        method: "POST",
        url: `/admin/products/${product.id}/inventory/adjustments`,
        headers: {
          authorization: `Bearer ${admin.id}`,
          "idempotency-key": randomUUID(),
        },
        payload: {
          delta: 50,
          note: "Massive restock",
        },
      });

      expect(res.statusCode).toBe(422);
      expect(res.json().error.code).toBe("STOCK_LIMIT_EXCEEDED");
    });

    it("requires Idempotency-Key header and returns 400 IDEMPOTENCY_KEY_REQUIRED if missing", async () => {
      const admin = await createAdmin();
      const product = await createProduct();

      const res = await app.inject({
        method: "POST",
        url: `/admin/products/${product.id}/inventory/adjustments`,
        headers: { authorization: `Bearer ${admin.id}` },
        payload: { delta: 10, note: "Restock" },
      });

      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe("IDEMPOTENCY_KEY_REQUIRED");
    });

    it("replays the original response without double-modifying inventory when retried with same idempotency key", async () => {
      const admin = await createAdmin();
      const product = await createProduct({}, { onHand: 10 });
      const key = randomUUID();

      // First request
      const res1 = await app.inject({
        method: "POST",
        url: `/admin/products/${product.id}/inventory/adjustments`,
        headers: { authorization: `Bearer ${admin.id}`, "idempotency-key": key },
        payload: { delta: 5, note: "First call" },
      });
      expect(res1.statusCode).toBe(200);
      expect(res1.json().replayed).toBe(false);
      expect(res1.json().inventory.quantityOnHand).toBe(15);

      // Second request (retry)
      const res2 = await app.inject({
        method: "POST",
        url: `/admin/products/${product.id}/inventory/adjustments`,
        headers: { authorization: `Bearer ${admin.id}`, "idempotency-key": key },
        payload: { delta: 5, note: "First call" },
      });
      expect(res2.statusCode).toBe(200);
      expect(res2.json().replayed).toBe(true);
      expect(res2.json().inventory.quantityOnHand).toBe(15);

      // Verify DB onHand is 15, NOT 20
      const [inv] = await db.select().from(inventory).where(eq(inventory.productId, product.id));
      expect(inv?.quantityOnHand).toBe(15);
    });

    it("returns 422 IDEMPOTENCY_KEY_REUSED when the same idempotency key is reused with a different payload", async () => {
      const admin = await createAdmin();
      const product = await createProduct();
      const key = randomUUID();

      await app.inject({
        method: "POST",
        url: `/admin/products/${product.id}/inventory/adjustments`,
        headers: { authorization: `Bearer ${admin.id}`, "idempotency-key": key },
        payload: { delta: 5, note: "Payload A" },
      });

      const res = await app.inject({
        method: "POST",
        url: `/admin/products/${product.id}/inventory/adjustments`,
        headers: { authorization: `Bearer ${admin.id}`, "idempotency-key": key },
        payload: { delta: 10, note: "Payload B" },
      });

      expect(res.statusCode).toBe(422);
      expect(res.json().error.code).toBe("IDEMPOTENCY_KEY_REUSED");
    });

    it("concurrency: 10 simultaneous +1 adjustments with distinct keys -> onHand increases by 10 with no lost updates", async () => {
      const admin = await createAdmin();
      const product = await createProduct({}, { onHand: 0 });

      const adjustOne = () =>
        app.inject({
          method: "POST",
          url: `/admin/products/${product.id}/inventory/adjustments`,
          headers: { authorization: `Bearer ${admin.id}`, "idempotency-key": randomUUID() },
          payload: { delta: 1, note: "Parallel increment" },
        });

      const results = await Promise.all(Array.from({ length: 10 }, adjustOne));
      expect(results.every((r) => r.statusCode === 200)).toBe(true);

      const [inv] = await db.select().from(inventory).where(eq(inventory.productId, product.id));
      expect(inv?.quantityOnHand).toBe(10);
      expect(inv?.version).toBe(10);
    });

    it("allows adjusting inventory for ARCHIVED products (physical stock operations)", async () => {
      const admin = await createAdmin();
      const product = await createProduct({ status: "ARCHIVED" }, { onHand: 5 });

      const res = await app.inject({
        method: "POST",
        url: `/admin/products/${product.id}/inventory/adjustments`,
        headers: { authorization: `Bearer ${admin.id}`, "idempotency-key": randomUUID() },
        payload: { delta: 5, note: "Warehouse recount for discontinued product" },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().inventory.quantityOnHand).toBe(10);
    });

    it("ledger reconciliation: SUM(deltaOnHand) matches quantityOnHand after a series of operations", async () => {
      const admin = await createAdmin();
      const product = await createProduct({}, { onHand: 10 }); // initial stock

      // Apply several adjustments: +5, -3, +12, -4
      const deltas = [5, -3, 12, -4];
      for (const d of deltas) {
        await app.inject({
          method: "POST",
          url: `/admin/products/${product.id}/inventory/adjustments`,
          headers: { authorization: `Bearer ${admin.id}`, "idempotency-key": randomUUID() },
          payload: { delta: d, note: `Delta ${d}` },
        });
      }

      const [sumRow] = await db
        .select({
          totalDeltaOnHand: sql<number>`COALESCE(SUM(${inventoryMovements.deltaOnHand}), 0)::int`,
        })
        .from(inventoryMovements)
        .where(eq(inventoryMovements.productId, product.id));

      const [invRow] = await db.select().from(inventory).where(eq(inventory.productId, product.id));

      // 10 + 5 - 3 + 12 - 4 = 20
      expect(invRow?.quantityOnHand).toBe(20);
      expect(sumRow?.totalDeltaOnHand).toBe(20);
    });
  });

  describe("GET /admin/products/:id/inventory/movements (Audit Ledger Inspection)", () => {
    it("returns paginated inventory movements for a product", async () => {
      const admin = await createAdmin();
      const product = await createProduct({}, { onHand: 0 });

      // Create 3 movements
      for (let i = 1; i <= 3; i++) {
        await app.inject({
          method: "POST",
          url: `/admin/products/${product.id}/inventory/adjustments`,
          headers: { authorization: `Bearer ${admin.id}`, "idempotency-key": randomUUID() },
          payload: { delta: i, note: `Adjustment #${i}` },
        });
      }

      const res = await app.inject({
        method: "GET",
        url: `/admin/products/${product.id}/inventory/movements?limit=2&offset=0`,
        headers: { authorization: `Bearer ${admin.id}` },
      });

      expect(res.statusCode).toBe(200);
      const data = res.json();
      expect(data.total).toBe(3);
      expect(data.items).toHaveLength(2);
      expect(data.items[0].note).toBe("Adjustment #3"); // ordered by createdAt desc
    });
  });
});
