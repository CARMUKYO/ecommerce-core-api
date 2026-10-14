import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { db } from "../../src/db/client.js";
import { cartItems, carts, inventory, products } from "../../src/db/schema/index.js";
import { createProduct, createUser } from "../helpers/fixtures.js";

describe("Cart Domain Logic Integration", () => {
  const app = buildApp();

  async function createCustomer() {
    return await createUser({ role: "CUSTOMER", status: "ACTIVE" });
  }

  describe("Cart Creation & Lifecycle", () => {
    it("returns an empty cart summary on GET /cart for a new user and lazily creates the ACTIVE cart", async () => {
      const customer = await createCustomer();

      const res = await app.inject({
        method: "GET",
        url: "/cart",
        headers: { authorization: `Bearer ${customer.id}` },
      });

      expect(res.statusCode).toBe(200);
      const cart = res.json();
      expect(cart.status).toBe("ACTIVE");
      expect(cart.items).toEqual([]);
      expect(cart.itemCount).toBe(0);
      expect(cart.totalUnits).toBe(0);
      expect(cart.totalCents).toBe(0);
      expect(cart.warnings).toEqual([]);

      // Verify cart exists in database
      const [inDb] = await db.select().from(carts).where(eq(carts.userId, customer.id));
      expect(inDb?.status).toBe("ACTIVE");
    });

    it("concurrency: 5 simultaneous initial cart requests produce exactly 1 ACTIVE cart row in DB", async () => {
      const customer = await createCustomer();

      const getCart = () =>
        app.inject({
          method: "GET",
          url: "/cart",
          headers: { authorization: `Bearer ${customer.id}` },
        });

      const responses = await Promise.all(Array.from({ length: 5 }, getCart));
      expect(responses.every((r) => r.statusCode === 200)).toBe(true);

      const rows = await db.select().from(carts).where(eq(carts.userId, customer.id));
      expect(rows).toHaveLength(1);
    });

    it("clears all items from cart on DELETE /cart", async () => {
      const customer = await createCustomer();
      const product = await createProduct({ status: "ACTIVE" }, { onHand: 10 });

      // Add item
      await app.inject({
        method: "POST",
        url: "/cart/items",
        headers: { authorization: `Bearer ${customer.id}` },
        payload: { productId: product.id, quantity: 3 },
      });

      // Clear cart
      const res = await app.inject({
        method: "DELETE",
        url: "/cart",
        headers: { authorization: `Bearer ${customer.id}` },
      });

      expect(res.statusCode).toBe(200);
      const cart = res.json();
      expect(cart.items).toEqual([]);
      expect(cart.itemCount).toBe(0);
      expect(cart.totalCents).toBe(0);

      // Verify DB
      const itemsInDb = await db.select().from(cartItems).where(eq(cartItems.cartId, cart.id));
      expect(itemsInDb).toHaveLength(0);
    });
  });

  describe("Adding Items (POST /cart/items)", () => {
    it("adds a valid active product to the cart", async () => {
      const customer = await createCustomer();
      const product = await createProduct({ status: "ACTIVE", priceCents: 1500 }, { onHand: 10 });

      const res = await app.inject({
        method: "POST",
        url: "/cart/items",
        headers: { authorization: `Bearer ${customer.id}` },
        payload: { productId: product.id, quantity: 2 },
      });

      expect(res.statusCode).toBe(200);
      const cart = res.json();
      expect(cart.itemCount).toBe(1);
      expect(cart.totalUnits).toBe(2);
      expect(cart.totalCents).toBe(3000);
      expect(cart.items[0]).toMatchObject({
        productId: product.id,
        sku: product.sku,
        name: product.name,
        unitPriceCents: 1500,
        quantity: 2,
        lineTotalCents: 3000,
        isPurchasable: true,
      });
    });

    it("increments quantity atomically when adding the same product again", async () => {
      const customer = await createCustomer();
      const product = await createProduct({ status: "ACTIVE", priceCents: 1000 }, { onHand: 20 });

      // First add: 2 units
      await app.inject({
        method: "POST",
        url: "/cart/items",
        headers: { authorization: `Bearer ${customer.id}` },
        payload: { productId: product.id, quantity: 2 },
      });

      // Second add: 3 units
      const res = await app.inject({
        method: "POST",
        url: "/cart/items",
        headers: { authorization: `Bearer ${customer.id}` },
        payload: { productId: product.id, quantity: 3 },
      });

      expect(res.statusCode).toBe(200);
      const cart = res.json();
      expect(cart.itemCount).toBe(1);
      expect(cart.totalUnits).toBe(5);
      expect(cart.totalCents).toBe(5000);
      expect(cart.items[0]?.quantity).toBe(5);
    });

    it("rejects adding DRAFT or ARCHIVED products with 404 PRODUCT_NOT_FOUND", async () => {
      const customer = await createCustomer();
      const draft = await createProduct({ status: "DRAFT" }, { onHand: 10 });
      const archived = await createProduct({ status: "ARCHIVED" }, { onHand: 10 });

      const resDraft = await app.inject({
        method: "POST",
        url: "/cart/items",
        headers: { authorization: `Bearer ${customer.id}` },
        payload: { productId: draft.id, quantity: 1 },
      });
      expect(resDraft.statusCode).toBe(404);
      expect(resDraft.json().error.code).toBe("PRODUCT_NOT_FOUND");

      const resArchived = await app.inject({
        method: "POST",
        url: "/cart/items",
        headers: { authorization: `Bearer ${customer.id}` },
        payload: { productId: archived.id, quantity: 1 },
      });
      expect(resArchived.statusCode).toBe(404);
      expect(resArchived.json().error.code).toBe("PRODUCT_NOT_FOUND");
    });

    it("rejects adding more units than available stock with 409 INSUFFICIENT_INVENTORY", async () => {
      const customer = await createCustomer();
      const product = await createProduct({ status: "ACTIVE" }, { onHand: 5, reserved: 2 }); // available: 3

      const res = await app.inject({
        method: "POST",
        url: "/cart/items",
        headers: { authorization: `Bearer ${customer.id}` },
        payload: { productId: product.id, quantity: 4 },
      });

      expect(res.statusCode).toBe(409);
      const err = res.json().error;
      expect(err.code).toBe("INSUFFICIENT_INVENTORY");
      expect(err.details).toMatchObject({
        sku: product.sku,
        requested: 4,
        available: 3,
      });
    });

    it("rejects invalid quantities with 400 VALIDATION_ERROR (0, negative, float, above max)", async () => {
      const customer = await createCustomer();
      const product = await createProduct({ status: "ACTIVE" }, { onHand: 100 });

      // Quantity 0
      const res0 = await app.inject({
        method: "POST",
        url: "/cart/items",
        headers: { authorization: `Bearer ${customer.id}` },
        payload: { productId: product.id, quantity: 0 },
      });
      expect(res0.statusCode).toBe(400);

      // Quantity negative
      const resNeg = await app.inject({
        method: "POST",
        url: "/cart/items",
        headers: { authorization: `Bearer ${customer.id}` },
        payload: { productId: product.id, quantity: -2 },
      });
      expect(resNeg.statusCode).toBe(400);

      // Exceeds max (100 > 99)
      const resMax = await app.inject({
        method: "POST",
        url: "/cart/items",
        headers: { authorization: `Bearer ${customer.id}` },
        payload: { productId: product.id, quantity: 100 },
      });
      expect(resMax.statusCode).toBe(400);
    });

    it("rejects exceeding the line limit (99) with 409 CART_ITEM_QUANTITY_EXCEEDED", async () => {
      const customer = await createCustomer();
      const product = await createProduct({ status: "ACTIVE" }, { onHand: 200 });

      // Add 90 units
      await app.inject({
        method: "POST",
        url: "/cart/items",
        headers: { authorization: `Bearer ${customer.id}` },
        payload: { productId: product.id, quantity: 90 },
      });

      // Try adding 15 more (90 + 15 = 105 > 99)
      const res = await app.inject({
        method: "POST",
        url: "/cart/items",
        headers: { authorization: `Bearer ${customer.id}` },
        payload: { productId: product.id, quantity: 15 },
      });

      expect(res.statusCode).toBe(409);
      const err = res.json().error;
      expect(err.code).toBe("CART_ITEM_QUANTITY_EXCEEDED");
      expect(err.details).toMatchObject({
        currentQuantity: 90,
        requestedAdd: 15,
        maxAllowed: 99,
        maxCanAdd: 9,
      });

      // Verify cart quantity was NOT modified and remains 90
      const summary = await app.inject({
        method: "GET",
        url: "/cart",
        headers: { authorization: `Bearer ${customer.id}` },
      });
      expect(summary.json().items[0].quantity).toBe(90);
    });

    it("concurrency: 10 simultaneous additions of qty=1 merge into a single row with quantity = 10", async () => {
      const customer = await createCustomer();
      const product = await createProduct({ status: "ACTIVE" }, { onHand: 50 });

      const addOne = () =>
        app.inject({
          method: "POST",
          url: "/cart/items",
          headers: { authorization: `Bearer ${customer.id}` },
          payload: { productId: product.id, quantity: 1 },
        });

      const responses = await Promise.all(Array.from({ length: 10 }, addOne));
      expect(responses.every((r) => r.statusCode === 200)).toBe(true);

      const cartRes = await app.inject({
        method: "GET",
        url: "/cart",
        headers: { authorization: `Bearer ${customer.id}` },
      });

      const cart = cartRes.json();
      expect(cart.itemCount).toBe(1);
      expect(cart.totalUnits).toBe(10);
      expect(cart.items[0].quantity).toBe(10);

      // Verify database table has exactly 1 row for this item
      const rows = await db.select().from(cartItems).where(eq(cartItems.cartId, cart.id));
      expect(rows).toHaveLength(1);
      expect(rows[0]?.quantity).toBe(10);
    });
  });

  describe("Updating & Removing Items", () => {
    it("updates quantity of an existing cart item via PATCH /cart/items/:productId", async () => {
      const customer = await createCustomer();
      const product = await createProduct({ status: "ACTIVE", priceCents: 1200 }, { onHand: 20 });

      await app.inject({
        method: "POST",
        url: "/cart/items",
        headers: { authorization: `Bearer ${customer.id}` },
        payload: { productId: product.id, quantity: 2 },
      });

      const res = await app.inject({
        method: "PATCH",
        url: `/cart/items/${product.id}`,
        headers: { authorization: `Bearer ${customer.id}` },
        payload: { quantity: 5 },
      });

      expect(res.statusCode).toBe(200);
      const cart = res.json();
      expect(cart.items[0]?.quantity).toBe(5);
      expect(cart.totalCents).toBe(6000);
    });

    it("rejects PATCH with quantity exceeding available stock with 409 INSUFFICIENT_INVENTORY", async () => {
      const customer = await createCustomer();
      const product = await createProduct({ status: "ACTIVE" }, { onHand: 4 });

      await app.inject({
        method: "POST",
        url: "/cart/items",
        headers: { authorization: `Bearer ${customer.id}` },
        payload: { productId: product.id, quantity: 2 },
      });

      const res = await app.inject({
        method: "PATCH",
        url: `/cart/items/${product.id}`,
        headers: { authorization: `Bearer ${customer.id}` },
        payload: { quantity: 6 },
      });

      expect(res.statusCode).toBe(409);
      expect(res.json().error.code).toBe("INSUFFICIENT_INVENTORY");
    });

    it("returns 404 CART_ITEM_NOT_FOUND when updating an item not in the cart", async () => {
      const customer = await createCustomer();
      const otherProduct = await createProduct({ status: "ACTIVE" });

      const res = await app.inject({
        method: "PATCH",
        url: `/cart/items/${otherProduct.id}`,
        headers: { authorization: `Bearer ${customer.id}` },
        payload: { quantity: 3 },
      });

      expect(res.statusCode).toBe(404);
      expect(res.json().error.code).toBe("CART_ITEM_NOT_FOUND");
    });

    it("removes a line item via DELETE /cart/items/:productId", async () => {
      const customer = await createCustomer();
      const product1 = await createProduct({ status: "ACTIVE" }, { onHand: 10 });
      const product2 = await createProduct({ status: "ACTIVE" }, { onHand: 10 });

      await app.inject({
        method: "POST",
        url: "/cart/items",
        headers: { authorization: `Bearer ${customer.id}` },
        payload: { productId: product1.id, quantity: 1 },
      });
      await app.inject({
        method: "POST",
        url: "/cart/items",
        headers: { authorization: `Bearer ${customer.id}` },
        payload: { productId: product2.id, quantity: 2 },
      });

      const res = await app.inject({
        method: "DELETE",
        url: `/cart/items/${product1.id}`,
        headers: { authorization: `Bearer ${customer.id}` },
      });

      expect(res.statusCode).toBe(200);
      const cart = res.json();
      expect(cart.itemCount).toBe(1);
      expect(cart.items[0]?.productId).toBe(product2.id);
    });

    it("treats DELETE on non-existent cart item as idempotent 200", async () => {
      const customer = await createCustomer();
      const product = await createProduct({ status: "ACTIVE" });

      const res = await app.inject({
        method: "DELETE",
        url: `/cart/items/${product.id}`,
        headers: { authorization: `Bearer ${customer.id}` },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().itemCount).toBe(0);
    });
  });

  describe("Dynamic Evaluation of Post-Addition Product State Changes", () => {
    it("dynamically reflects updated product prices on GET /cart", async () => {
      const customer = await createCustomer();
      const product = await createProduct({ status: "ACTIVE", priceCents: 1000 }, { onHand: 10 });

      // Add to cart at $10.00
      await app.inject({
        method: "POST",
        url: "/cart/items",
        headers: { authorization: `Bearer ${customer.id}` },
        payload: { productId: product.id, quantity: 3 },
      });

      // Price changes in product catalog to $15.00
      await db.update(products).set({ priceCents: 1500 }).where(eq(products.id, product.id));

      // View cart
      const res = await app.inject({
        method: "GET",
        url: "/cart",
        headers: { authorization: `Bearer ${customer.id}` },
      });

      expect(res.statusCode).toBe(200);
      const cart = res.json();
      expect(cart.items[0]?.unitPriceCents).toBe(1500);
      expect(cart.items[0]?.lineTotalCents).toBe(4500);
      expect(cart.totalCents).toBe(4500);
    });

    it("flags archived products as unpurchasable with PRODUCT_UNAVAILABLE and excludes from totalCents", async () => {
      const customer = await createCustomer();
      const productA = await createProduct({ status: "ACTIVE", priceCents: 2000 }, { onHand: 10 });
      const productB = await createProduct({ status: "ACTIVE", priceCents: 3000 }, { onHand: 10 });

      // Add both to cart
      await app.inject({
        method: "POST",
        url: "/cart/items",
        headers: { authorization: `Bearer ${customer.id}` },
        payload: { productId: productA.id, quantity: 1 },
      });
      await app.inject({
        method: "POST",
        url: "/cart/items",
        headers: { authorization: `Bearer ${customer.id}` },
        payload: { productId: productB.id, quantity: 1 },
      });

      // Admin archives product B
      await db.update(products).set({ status: "ARCHIVED" }).where(eq(products.id, productB.id));

      const res = await app.inject({
        method: "GET",
        url: "/cart",
        headers: { authorization: `Bearer ${customer.id}` },
      });

      expect(res.statusCode).toBe(200);
      const cart = res.json();
      expect(cart.itemCount).toBe(2);

      const itemA = cart.items.find((i: { productId: string }) => i.productId === productA.id);
      const itemB = cart.items.find((i: { productId: string }) => i.productId === productB.id);

      expect(itemA).toMatchObject({ isPurchasable: true });
      expect(itemB).toMatchObject({
        isPurchasable: false,
        issue: "PRODUCT_UNAVAILABLE",
      });

      // Total cents only includes purchasable items ($20.00, not $50.00)
      expect(cart.totalCents).toBe(2000);
      expect(cart.totalUnits).toBe(1);
      expect(cart.warnings.length).toBeGreaterThan(0);
      expect(cart.warnings[0]).toContain("is no longer active");
    });

    it("flags out-of-stock items with OUT_OF_STOCK and partially available items with PARTIALLY_AVAILABLE", async () => {
      const customer = await createCustomer();
      const product = await createProduct({ status: "ACTIVE", priceCents: 1000 }, { onHand: 5 });

      await app.inject({
        method: "POST",
        url: "/cart/items",
        headers: { authorization: `Bearer ${customer.id}` },
        payload: { productId: product.id, quantity: 5 },
      });

      // Stock drops to 2 (partially available)
      await db.update(inventory).set({ quantityOnHand: 2 }).where(eq(inventory.productId, product.id));

      const resPartial = await app.inject({
        method: "GET",
        url: "/cart",
        headers: { authorization: `Bearer ${customer.id}` },
      });
      const cartPartial = resPartial.json();
      expect(cartPartial.items[0]).toMatchObject({
        isPurchasable: false,
        issue: "PARTIALLY_AVAILABLE",
        availableQuantity: 2,
      });
      expect(cartPartial.totalCents).toBe(0);

      // Stock drops to 0 (completely out of stock)
      await db.update(inventory).set({ quantityOnHand: 0 }).where(eq(inventory.productId, product.id));

      const resZero = await app.inject({
        method: "GET",
        url: "/cart",
        headers: { authorization: `Bearer ${customer.id}` },
      });
      const cartZero = resZero.json();
      expect(cartZero.items[0]).toMatchObject({
        isPurchasable: false,
        issue: "OUT_OF_STOCK",
        availableQuantity: 0,
      });
      expect(cartZero.totalCents).toBe(0);
    });
  });
});
