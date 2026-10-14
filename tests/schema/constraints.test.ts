/**
 * Phase 1 — Schema integrity tests.
 *
 * These run against a real PostgreSQL instance and prove that the invariants
 * from the approved design are enforced by the DATABASE itself, independent of
 * any application code. Services built in later phases are a first line of
 * defense; these constraints are the last.
 */
import { randomUUID } from "node:crypto";
import { and, eq, gte, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { db } from "../../src/db/client.js";
import {
  cartItems,
  carts,
  inventory,
  inventoryMovements,
  orderItems,
  orders,
  products,
  users,
} from "../../src/db/schema/index.js";
import { createCart, createOrderWithItem, createProduct, createUser } from "../helpers/fixtures.js";
import { expectPgError, findPgError, PG } from "../helpers/pg-errors.js";

describe("Edge Case 1 — inventory can never be oversold", () => {
  it("rejects quantity_reserved > quantity_on_hand", async () => {
    const product = await createProduct({}, { onHand: 1 });
    await expectPgError(
      db.update(inventory).set({ quantityReserved: 2 }).where(eq(inventory.productId, product.id)),
      { code: PG.CHECK_VIOLATION, constraint: "inventory_reserved_lte_on_hand_chk" },
    );
  });

  it("rejects negative on_hand and negative reserved", async () => {
    const product = await createProduct({}, { onHand: 0 });
    await expectPgError(
      db.update(inventory).set({ quantityOnHand: -1 }).where(eq(inventory.productId, product.id)),
      { code: PG.CHECK_VIOLATION },
    );
    await expectPgError(
      db.update(inventory).set({ quantityReserved: -1 }).where(eq(inventory.productId, product.id)),
      { code: PG.CHECK_VIOLATION, constraint: "inventory_reserved_non_negative_chk" },
    );
  });

  it("rejects an admin lowering on_hand below what is already reserved", async () => {
    const product = await createProduct({}, { onHand: 10, reserved: 7 });
    await expectPgError(
      db.update(inventory).set({ quantityOnHand: 5 }).where(eq(inventory.productId, product.id)),
      { code: PG.CHECK_VIOLATION, constraint: "inventory_reserved_lte_on_hand_chk" },
    );
  });

  it("even naive unguarded concurrent increments cannot persist an oversell (CHECK is the backstop)", async () => {
    const product = await createProduct({}, { onHand: 1 });
    const naiveReserve = () =>
      db
        .update(inventory)
        .set({ quantityReserved: sql`${inventory.quantityReserved} + 1` })
        .where(eq(inventory.productId, product.id));

    const results = await Promise.allSettled([naiveReserve(), naiveReserve()]);
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(findPgError(rejected[0]!.reason)?.code).toBe(PG.CHECK_VIOLATION);

    const [row] = await db.select().from(inventory).where(eq(inventory.productId, product.id));
    expect(row).toMatchObject({ quantityOnHand: 1, quantityReserved: 1 });
  });

  it("guarded conditional updates: 5 concurrent reservations of 1 unit against 2 available -> exactly 2 succeed", async () => {
    const product = await createProduct({}, { onHand: 2 });
    const guardedReserve = async (qty: number) => {
      const updated = await db
        .update(inventory)
        .set({
          quantityReserved: sql`${inventory.quantityReserved} + ${qty}`,
          version: sql`${inventory.version} + 1`,
        })
        .where(
          and(
            eq(inventory.productId, product.id),
            gte(sql`${inventory.quantityOnHand} - ${inventory.quantityReserved}`, qty),
          ),
        )
        .returning({ productId: inventory.productId });
      return updated.length === 1;
    };

    const outcomes = await Promise.all(Array.from({ length: 5 }, () => guardedReserve(1)));
    expect(outcomes.filter(Boolean)).toHaveLength(2);

    const [row] = await db.select().from(inventory).where(eq(inventory.productId, product.id));
    expect(row).toMatchObject({ quantityOnHand: 2, quantityReserved: 2, version: 2 });
  });
});

describe("Edge Case 2 — duplicate active carts / duplicate cart lines", () => {
  it("rejects a second ACTIVE cart for the same user", async () => {
    const user = await createUser();
    await createCart(user.id);
    await expectPgError(createCart(user.id), {
      code: PG.UNIQUE_VIOLATION,
      constraint: "carts_one_active_per_user_uidx",
    });
  });

  it("allows many historical (CONVERTED/ABANDONED) carts alongside one ACTIVE cart", async () => {
    const user = await createUser();
    await createCart(user.id, "CONVERTED");
    await createCart(user.id, "CONVERTED");
    await createCart(user.id, "ABANDONED");
    await createCart(user.id, "ACTIVE");
    const rows = await db.select().from(carts).where(eq(carts.userId, user.id));
    expect(rows).toHaveLength(4);
  });

  it("concurrent 'create cart' requests for one user produce exactly one ACTIVE cart", async () => {
    const user = await createUser();
    const results = await Promise.allSettled(Array.from({ length: 5 }, () => createCart(user.id)));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const active = await db
      .select()
      .from(carts)
      .where(and(eq(carts.userId, user.id), eq(carts.status, "ACTIVE")));
    expect(active).toHaveLength(1);
  });

  it("rejects a duplicate (cart_id, product_id) line", async () => {
    const user = await createUser();
    const product = await createProduct();
    const cart = await createCart(user.id);
    await db.insert(cartItems).values({ cartId: cart.id, productId: product.id, quantity: 1 });
    await expectPgError(db.insert(cartItems).values({ cartId: cart.id, productId: product.id, quantity: 1 }), {
      code: PG.UNIQUE_VIOLATION,
      constraint: "cart_items_cart_product_uidx",
    });
  });

  it("concurrent ON CONFLICT upserts merge into a single line with summed quantity", async () => {
    const user = await createUser();
    const product = await createProduct();
    const cart = await createCart(user.id);
    const addOne = () =>
      db
        .insert(cartItems)
        .values({ cartId: cart.id, productId: product.id, quantity: 1 })
        .onConflictDoUpdate({
          target: [cartItems.cartId, cartItems.productId],
          set: { quantity: sql`${cartItems.quantity} + excluded.quantity` },
        });

    await Promise.all(Array.from({ length: 10 }, addOne));
    const lines = await db.select().from(cartItems).where(eq(cartItems.cartId, cart.id));
    expect(lines).toHaveLength(1);
    expect(lines[0]!.quantity).toBe(10);
  });

  it.each([0, -1, 1000])("rejects cart line quantity %i (hard bounds 1..999)", async (quantity) => {
    const user = await createUser();
    const product = await createProduct();
    const cart = await createCart(user.id);
    await expectPgError(db.insert(cartItems).values({ cartId: cart.id, productId: product.id, quantity }), {
      code: PG.CHECK_VIOLATION,
      constraint: "cart_items_quantity_bounds_chk",
    });
  });

  it("deleting a cart cascades to its lines (composition)", async () => {
    const user = await createUser();
    const product = await createProduct();
    const cart = await createCart(user.id, "ABANDONED");
    await db.insert(cartItems).values({ cartId: cart.id, productId: product.id, quantity: 2 });
    await db.delete(carts).where(eq(carts.id, cart.id));
    expect(await db.select().from(cartItems).where(eq(cartItems.cartId, cart.id))).toHaveLength(0);
  });
});

describe("Edge Case 3 — historical orders cannot be rewritten", () => {
  it("prevents hard-deleting a product that appears in past orders", async () => {
    const user = await createUser();
    const product = await createProduct();
    await createOrderWithItem(user, product);
    await expectPgError(db.delete(products).where(eq(products.id, product.id)), {
      code: PG.RESTRICT_VIOLATION,
    });
  });

  it("prevents hard-deleting a product sitting in a cart", async () => {
    const user = await createUser();
    const product = await createProduct();
    const cart = await createCart(user.id);
    await db.insert(cartItems).values({ cartId: cart.id, productId: product.id, quantity: 1 });
    await expectPgError(db.delete(products).where(eq(products.id, product.id)), {
      code: PG.RESTRICT_VIOLATION,
      constraint: "cart_items_product_id_products_id_fk",
    });
  });

  it("prevents deleting an order (and therefore silently dropping its lines)", async () => {
    const user = await createUser();
    const product = await createProduct();
    const order = await createOrderWithItem(user, product);
    await expectPgError(db.delete(orders).where(eq(orders.id, order.id)), {
      code: PG.RESTRICT_VIOLATION,
      constraint: "order_items_order_id_orders_id_fk",
    });
  });

  it("prevents deleting a user who has orders", async () => {
    const user = await createUser();
    const product = await createProduct();
    await createOrderWithItem(user, product);
    await expectPgError(db.delete(users).where(eq(users.id, user.id)), { code: PG.RESTRICT_VIOLATION });
  });

  it("snapshots survive price changes and renames of the live product", async () => {
    const user = await createUser();
    const product = await createProduct({ name: "Original Name", priceCents: 1999 });
    const order = await createOrderWithItem(user, product, 2);

    await db
      .update(products)
      .set({ name: "Renamed", priceCents: 2499, status: "ARCHIVED" })
      .where(eq(products.id, product.id));

    const [item] = await db.select().from(orderItems).where(eq(orderItems.orderId, order.id));
    expect(item).toMatchObject({
      productNameSnapshot: "Original Name",
      unitPriceCentsSnapshot: 1999,
      lineTotalCents: 3998,
    });
    const [persistedOrder] = await db.select().from(orders).where(eq(orders.id, order.id));
    expect(persistedOrder!.totalCents).toBe(3998);
  });

  it("rejects an order line whose line_total != quantity x unit price", async () => {
    const user = await createUser();
    const product = await createProduct();
    const order = await createOrderWithItem(user, product);
    const other = await createProduct();
    await expectPgError(
      db.insert(orderItems).values({
        orderId: order.id,
        productId: other.id,
        quantity: 3,
        unitPriceCentsSnapshot: 1000,
        productNameSnapshot: other.name,
        skuSnapshot: other.sku,
        lineTotalCents: 2999,
      }),
      { code: PG.CHECK_VIOLATION, constraint: "order_items_line_total_chk" },
    );
  });
});

describe("Bonus — duplicate orders from retried checkout", () => {
  async function insertOrder(userId: string, cartId: string, idempotencyKey: string) {
    return db.insert(orders).values({
      userId,
      cartId,
      idempotencyKey,
      requestFingerprint: "fp",
      totalCents: 0,
      currency: "USD",
    });
  }

  it("rejects the same idempotency key twice for the same user", async () => {
    const user = await createUser();
    const key = randomUUID();
    await insertOrder(user.id, (await createCart(user.id, "CONVERTED")).id, key);
    await expectPgError(insertOrder(user.id, (await createCart(user.id, "CONVERTED")).id, key), {
      code: PG.UNIQUE_VIOLATION,
      constraint: "orders_user_idempotency_key_uidx",
    });
  });

  it("allows different users to use the same idempotency key (per-user scope)", async () => {
    const alice = await createUser();
    const bob = await createUser();
    const key = "shared-key";
    await insertOrder(alice.id, (await createCart(alice.id, "CONVERTED")).id, key);
    await insertOrder(bob.id, (await createCart(bob.id, "CONVERTED")).id, key);
    expect(await db.select().from(orders)).toHaveLength(2);
  });

  it("a cart can convert into at most one order, even with a different idempotency key", async () => {
    const user = await createUser();
    const cart = await createCart(user.id, "CONVERTED");
    await insertOrder(user.id, cart.id, randomUUID());
    await expectPgError(insertOrder(user.id, cart.id, randomUUID()), {
      code: PG.UNIQUE_VIOLATION,
      constraint: "orders_cart_id_key",
    });
  });

  it("concurrent retries with the same key create exactly one order", async () => {
    const user = await createUser();
    const key = randomUUID();
    const cartIds = await Promise.all(
      Array.from({ length: 5 }, async () => (await createCart(user.id, "CONVERTED")).id),
    );
    const results = await Promise.allSettled(cartIds.map((cartId) => insertOrder(user.id, cartId, key)));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  });
});

describe("Field-level integrity", () => {
  it("normalizes uniqueness: rejects non-lowercase emails", async () => {
    await expectPgError(createUser({ email: "Bob@Example.com" }), {
      code: PG.CHECK_VIOLATION,
      constraint: "users_email_lowercase_chk",
    });
  });

  it("rejects duplicate emails", async () => {
    await createUser({ email: "bob@example.com" });
    await expectPgError(createUser({ email: "bob@example.com" }), {
      code: PG.UNIQUE_VIOLATION,
      constraint: "users_email_key",
    });
  });

  it("rejects non-uppercase SKUs (prevents sku-101 vs SKU-101 duplicates)", async () => {
    await expectPgError(createProduct({ sku: "sku-101" }), {
      code: PG.CHECK_VIOLATION,
      constraint: "products_sku_format_chk",
    });
  });

  it("rejects negative prices and malformed currency codes", async () => {
    await expectPgError(createProduct({ priceCents: -1 }), {
      code: PG.CHECK_VIOLATION,
      constraint: "products_price_non_negative_chk",
    });
    await expectPgError(createProduct({ currency: "usd" }), {
      code: PG.CHECK_VIOLATION,
      constraint: "products_currency_iso_chk",
    });
  });

  it("order status and lifecycle timestamps cannot disagree", async () => {
    const user = await createUser();
    const product = await createProduct();
    const order = await createOrderWithItem(user, product);

    await expectPgError(db.update(orders).set({ status: "CANCELLED" }).where(eq(orders.id, order.id)), {
      code: PG.CHECK_VIOLATION,
      constraint: "orders_cancelled_at_consistency_chk",
    });
    await expectPgError(db.update(orders).set({ status: "PAID" }).where(eq(orders.id, order.id)), {
      code: PG.CHECK_VIOLATION,
      constraint: "orders_paid_at_consistency_chk",
    });

    // Valid transition writes both together.
    await db.update(orders).set({ status: "PAID", paidAt: new Date() }).where(eq(orders.id, order.id));
    await db.update(orders).set({ status: "CANCELLED", cancelledAt: new Date() }).where(eq(orders.id, order.id));
  });

  it("order-driven inventory movements must reference an order", async () => {
    const product = await createProduct();
    await expectPgError(
      db.insert(inventoryMovements).values({ productId: product.id, deltaReserved: 1, reason: "ORDER_RESERVED" }),
      { code: PG.CHECK_VIOLATION, constraint: "inventory_movements_order_ref_chk" },
    );
  });

  it("inventory movements must change something", async () => {
    const product = await createProduct();
    await expectPgError(
      db.insert(inventoryMovements).values({ productId: product.id, reason: "ADMIN_ADJUSTMENT" }),
      { code: PG.CHECK_VIOLATION, constraint: "inventory_movements_non_zero_chk" },
    );
  });
});
