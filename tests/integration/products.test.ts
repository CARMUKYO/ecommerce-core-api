import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { db } from "../../src/db/client.js";
import { inventoryMovements, orderItems, products } from "../../src/db/schema/index.js";
import { createOrderWithItem, createProduct, createUser } from "../helpers/fixtures.js";

describe("Products API Integration", () => {
  const app = buildApp();

  async function createAdmin() {
    return await createUser({ role: "ADMIN", status: "ACTIVE" });
  }

  describe("POST /admin/products (Product Creation)", () => {
    it("creates a product in DRAFT status with initial stock and movement ledger entry", async () => {
      const admin = await createAdmin();
      const res = await app.inject({
        method: "POST",
        url: "/admin/products",
        headers: { authorization: `Bearer ${admin.token}` },
        payload: {
          sku: "tshirt-blue-m",
          name: "Blue T-Shirt Medium",
          description: "Comfortable cotton t-shirt",
          priceCents: 2499,
          currency: "USD",
          initialStock: 50,
        },
      });

      expect(res.statusCode).toBe(201);
      const { product } = res.json();
      expect(product.sku).toBe("TSHIRT-BLUE-M"); // Uppercased and trimmed
      expect(product.status).toBe("DRAFT");
      expect(product.priceCents).toBe(2499);
      expect(product.inventory).toMatchObject({
        quantityOnHand: 50,
        quantityReserved: 0,
        availableQuantity: 50,
        inStock: true,
      });

      // Verify ledger entry
      const movements = await db.select().from(inventoryMovements).where(eq(inventoryMovements.productId, product.id));
      expect(movements).toHaveLength(1);
      expect(movements[0]).toMatchObject({
        deltaOnHand: 50,
        deltaReserved: 0,
        reason: "INITIAL_STOCK",
        actorUserId: admin.id,
      });
    });

    it("creates product with 0 initial stock without creating an inventory movement", async () => {
      const admin = await createAdmin();
      const res = await app.inject({
        method: "POST",
        url: "/admin/products",
        headers: { authorization: `Bearer ${admin.token}` },
        payload: {
          sku: "CAP-RED",
          name: "Red Cap",
          priceCents: 1500,
          initialStock: 0,
        },
      });

      expect(res.statusCode).toBe(201);
      const { product } = res.json();
      expect(product.inventory.quantityOnHand).toBe(0);

      const movements = await db.select().from(inventoryMovements).where(eq(inventoryMovements.productId, product.id));
      expect(movements).toHaveLength(0);
    });

    it("returns 409 SKU_ALREADY_EXISTS when SKU is duplicated (even with different casing/whitespace)", async () => {
      const admin = await createAdmin();
      await app.inject({
        method: "POST",
        url: "/admin/products",
        headers: { authorization: `Bearer ${admin.token}` },
        payload: { sku: "DUPLICATE-SKU", name: "Original", priceCents: 1000 },
      });

      const res = await app.inject({
        method: "POST",
        url: "/admin/products",
        headers: { authorization: `Bearer ${admin.token}` },
        payload: { sku: " duplicate-sku ", name: "Copycat", priceCents: 1200 },
      });

      expect(res.statusCode).toBe(409);
      expect(res.json().error.code).toBe("SKU_ALREADY_EXISTS");
    });

    it("concurrency: 5 simultaneous requests with the same SKU -> exactly 1 succeeds (201) and 4 fail (409)", async () => {
      const admin = await createAdmin();
      const createReq = () =>
        app.inject({
          method: "POST",
          url: "/admin/products",
          headers: { authorization: `Bearer ${admin.token}` },
          payload: { sku: "RACE-SKU", name: "Race Item", priceCents: 1999 },
        });

      const responses = await Promise.all(Array.from({ length: 5 }, createReq));
      const successes = responses.filter((r) => r.statusCode === 201);
      const conflicts = responses.filter((r) => r.statusCode === 409);

      expect(successes).toHaveLength(1);
      expect(conflicts).toHaveLength(4);
      for (const c of conflicts) {
        expect(c.json().error.code).toBe("SKU_ALREADY_EXISTS");
      }
    });

    it("rejects invalid input with 400 VALIDATION_ERROR (float prices, negative prices, empty name)", async () => {
      const admin = await createAdmin();

      // Float price
      const floatRes = await app.inject({
        method: "POST",
        url: "/admin/products",
        headers: { authorization: `Bearer ${admin.token}` },
        payload: { sku: "FLOAT-PRICE", name: "Item", priceCents: 19.99 },
      });
      expect(floatRes.statusCode).toBe(400);
      expect(floatRes.json().error.code).toBe("VALIDATION_ERROR");

      // Negative price
      const negRes = await app.inject({
        method: "POST",
        url: "/admin/products",
        headers: { authorization: `Bearer ${admin.token}` },
        payload: { sku: "NEG-PRICE", name: "Item", priceCents: -500 },
      });
      expect(negRes.statusCode).toBe(400);

      // Blank name
      const blankRes = await app.inject({
        method: "POST",
        url: "/admin/products",
        headers: { authorization: `Bearer ${admin.token}` },
        payload: { sku: "BLANK-NAME", name: "   ", priceCents: 1000 },
      });
      expect(blankRes.statusCode).toBe(400);
    });
  });

  describe("Product Status Transitions (State Machine)", () => {
    it("allows DRAFT -> ACTIVE, ACTIVE -> ARCHIVED, and ARCHIVED -> ACTIVE", async () => {
      const admin = await createAdmin();
      const product = await createProduct({ status: "DRAFT", priceCents: 2000 });

      // 1. Activate
      const actRes = await app.inject({
        method: "POST",
        url: `/admin/products/${product.id}/activate`,
        headers: { authorization: `Bearer ${admin.token}` },
      });
      expect(actRes.statusCode).toBe(200);
      expect(actRes.json().product.status).toBe("ACTIVE");

      // 2. Archive
      const arcRes = await app.inject({
        method: "POST",
        url: `/admin/products/${product.id}/archive`,
        headers: { authorization: `Bearer ${admin.token}` },
      });
      expect(arcRes.statusCode).toBe(200);
      expect(arcRes.json().product.status).toBe("ARCHIVED");

      // 3. Re-list to ACTIVE
      const relistRes = await app.inject({
        method: "POST",
        url: `/admin/products/${product.id}/activate`,
        headers: { authorization: `Bearer ${admin.token}` },
      });
      expect(relistRes.statusCode).toBe(200);
      expect(relistRes.json().product.status).toBe("ACTIVE");
    });

    it("rejects activation with 422 PRODUCT_NOT_ACTIVATABLE if price is 0 cents", async () => {
      const admin = await createAdmin();
      const product = await createProduct({ status: "DRAFT", priceCents: 0 });

      const res = await app.inject({
        method: "POST",
        url: `/admin/products/${product.id}/activate`,
        headers: { authorization: `Bearer ${admin.token}` },
      });

      expect(res.statusCode).toBe(422);
      expect(res.json().error.code).toBe("PRODUCT_NOT_ACTIVATABLE");

      // Verify status remains DRAFT in DB
      const [inDb] = await db.select().from(products).where(eq(products.id, product.id));
      expect(inDb?.status).toBe("DRAFT");
    });

    it("treats same-status transition as an idempotent 200 no-op", async () => {
      const admin = await createAdmin();
      const product = await createProduct({ status: "ACTIVE", priceCents: 1500 });

      const res = await app.inject({
        method: "POST",
        url: `/admin/products/${product.id}/activate`,
        headers: { authorization: `Bearer ${admin.token}` },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().product.status).toBe("ACTIVE");
    });

    it("concurrency: simultaneous activate and archive on DRAFT -> exactly one succeeds and one fails 409", async () => {
      const admin = await createAdmin();
      const product = await createProduct({ status: "DRAFT", priceCents: 1000 });

      const [res1, res2] = await Promise.all([
        app.inject({
          method: "POST",
          url: `/admin/products/${product.id}/activate`,
          headers: { authorization: `Bearer ${admin.token}` },
        }),
        app.inject({
          method: "POST",
          url: `/admin/products/${product.id}/archive`,
          headers: { authorization: `Bearer ${admin.token}` },
        }),
      ]);

      const statuses = [res1.statusCode, res2.statusCode];
      expect(statuses).toContain(200);
      expect(statuses).toContain(409);

      const errRes = res1.statusCode === 409 ? res1 : res2;
      expect(errRes.json().error.code).toBe("INVALID_PRODUCT_STATUS_TRANSITION");
    });
  });

  describe("PATCH /admin/products/:id (Field Updates)", () => {
    it("updates product details and does NOT alter historical order item snapshots", async () => {
      const admin = await createAdmin();
      const customer = await createUser();
      const product = await createProduct({ status: "ACTIVE", priceCents: 1999, name: "Original Name" });

      // Place an order holding historical snapshot
      const order = await createOrderWithItem(customer, product, 2);

      // Admin updates product price and name
      const res = await app.inject({
        method: "PATCH",
        url: `/admin/products/${product.id}`,
        headers: { authorization: `Bearer ${admin.token}` },
        payload: {
          name: "Updated Name",
          priceCents: 2999,
        },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().product.name).toBe("Updated Name");
      expect(res.json().product.priceCents).toBe(2999);

      // Verify historical order item snapshot was NOT modified
      const [orderItem] = await db.select().from(orderItems).where(eq(orderItems.orderId, order.id));
      expect(orderItem?.productNameSnapshot).toBe("Original Name");
      expect(orderItem?.unitPriceCentsSnapshot).toBe(1999);
      expect(orderItem?.lineTotalCents).toBe(3998);
    });

    it("allows SKU update on DRAFT products, but rejects SKU update on ACTIVE products with 409 SKU_IMMUTABLE", async () => {
      const admin = await createAdmin();
      const draft = await createProduct({ status: "DRAFT", sku: "DRAFT-SKU-1" });

      // Allowed on DRAFT
      const draftRes = await app.inject({
        method: "PATCH",
        url: `/admin/products/${draft.id}`,
        headers: { authorization: `Bearer ${admin.token}` },
        payload: { sku: "draft-sku-updated" },
      });
      expect(draftRes.statusCode).toBe(200);
      expect(draftRes.json().product.sku).toBe("DRAFT-SKU-UPDATED");

      // Rejected on ACTIVE
      const active = await createProduct({ status: "ACTIVE", sku: "ACTIVE-SKU-1" });
      const activeRes = await app.inject({
        method: "PATCH",
        url: `/admin/products/${active.id}`,
        headers: { authorization: `Bearer ${admin.token}` },
        payload: { sku: "NEW-SKU" },
      });
      expect(activeRes.statusCode).toBe(409);
      expect(activeRes.json().error.code).toBe("SKU_IMMUTABLE");
    });

    it("rejects editing ARCHIVED products with 409 PRODUCT_NOT_EDITABLE", async () => {
      const admin = await createAdmin();
      const archived = await createProduct({ status: "ARCHIVED" });

      const res = await app.inject({
        method: "PATCH",
        url: `/admin/products/${archived.id}`,
        headers: { authorization: `Bearer ${admin.token}` },
        payload: { name: "Try to rename" },
      });

      expect(res.statusCode).toBe(409);
      expect(res.json().error.code).toBe("PRODUCT_NOT_EDITABLE");
    });

    it("rejects setting price to 0 on an ACTIVE product with 422 PRODUCT_NOT_ACTIVATABLE", async () => {
      const admin = await createAdmin();
      const active = await createProduct({ status: "ACTIVE", priceCents: 1500 });

      const res = await app.inject({
        method: "PATCH",
        url: `/admin/products/${active.id}`,
        headers: { authorization: `Bearer ${admin.token}` },
        payload: { priceCents: 0 },
      });

      expect(res.statusCode).toBe(422);
      expect(res.json().error.code).toBe("PRODUCT_NOT_ACTIVATABLE");
    });

    it("returns 400 VALIDATION_ERROR on empty PATCH body", async () => {
      const admin = await createAdmin();
      const product = await createProduct();

      const res = await app.inject({
        method: "PATCH",
        url: `/admin/products/${product.id}`,
        headers: { authorization: `Bearer ${admin.token}` },
        payload: {},
      });

      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe("VALIDATION_ERROR");
    });
  });

  describe("Public Product Catalog", () => {
    it("lists ONLY ACTIVE products on GET /products", async () => {
      await createProduct({ status: "DRAFT", name: "Draft Item" });
      await createProduct({ status: "ARCHIVED", name: "Archived Item" });
      const active = await createProduct({ status: "ACTIVE", name: "Active Item" });

      const res = await app.inject({
        method: "GET",
        url: "/products",
      });

      expect(res.statusCode).toBe(200);
      const { items } = res.json();
      expect(items.some((i: { id: string }) => i.id === active.id)).toBe(true);
      expect(items.every((i: { status: string }) => i.status === "ACTIVE")).toBe(true);
    });

    it("returns 404 PRODUCT_NOT_FOUND when accessing non-ACTIVE products via GET /products/:id", async () => {
      const draft = await createProduct({ status: "DRAFT" });
      const archived = await createProduct({ status: "ARCHIVED" });

      const res1 = await app.inject({ method: "GET", url: `/products/${draft.id}` });
      expect(res1.statusCode).toBe(404);
      expect(res1.json().error.code).toBe("PRODUCT_NOT_FOUND");

      const res2 = await app.inject({ method: "GET", url: `/products/${archived.id}` });
      expect(res2.statusCode).toBe(404);
      expect(res2.json().error.code).toBe("PRODUCT_NOT_FOUND");
    });

    it("correctly exposes inventory availability (onHand - reserved)", async () => {
      const product = await createProduct({ status: "ACTIVE" }, { onHand: 10, reserved: 3 });

      const res = await app.inject({ method: "GET", url: `/products/${product.id}` });
      expect(res.statusCode).toBe(200);
      const { product: data } = res.json();
      expect(data.inventory).toMatchObject({
        availableQuantity: 7,
        inStock: true,
      });
    });

    it("exposes ONLY availability on public routes: no on-hand, reserved, or version", async () => {
      const product = await createProduct({ status: "ACTIVE" }, { onHand: 10, reserved: 3 });

      const detail = await app.inject({ method: "GET", url: `/products/${product.id}` });
      const list = await app.inject({ method: "GET", url: "/products" });
      const listed = list.json().items.find((i: { id: string }) => i.id === product.id);

      for (const p of [detail.json().product, listed]) {
        expect(p.inventory).toEqual({ availableQuantity: 7, inStock: true });
        expect(Object.keys(p).sort()).toEqual(
          ["createdAt", "currency", "description", "id", "inventory", "name", "priceCents", "sku", "status", "updatedAt"],
        );
      }
    });

    it("still exposes full inventory detail on admin routes", async () => {
      const admin = await createUser({ role: "ADMIN" });
      const product = await createProduct({ status: "ACTIVE" }, { onHand: 10, reserved: 3 });

      const res = await app.inject({
        method: "GET",
        url: `/admin/products/${product.id}`,
        headers: { authorization: `Bearer ${admin.token}` },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().product.inventory).toEqual({
        quantityOnHand: 10,
        quantityReserved: 3,
        availableQuantity: 7,
        inStock: true,
        version: 0,
      });
    });
  });
});
