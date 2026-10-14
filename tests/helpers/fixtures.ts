import { randomUUID } from "node:crypto";
import { db } from "../../src/db/client.js";
import {
  carts,
  inventory,
  inventoryMovements,
  orderItems,
  orders,
  products,
  sessions,
  users,
  type Cart,
  type NewProduct,
  type Order,
  type Product,
  type User,
} from "../../src/db/schema/index.js";
import { generateSessionToken, hashSessionToken } from "../../src/modules/auth/credentials.js";

export type TestUser = User & { token: string };

/**
 * Creates a user plus a live session, returning the raw bearer token. The
 * password hash is a placeholder (no scrypt cost); tests that exercise real
 * login go through POST /auth/register + /auth/login instead.
 */
export async function createUser(overrides: Partial<typeof users.$inferInsert> = {}): Promise<TestUser> {
  const [row] = await db
    .insert(users)
    .values({ email: `user-${randomUUID()}@test.dev`, passwordHash: "x", ...overrides })
    .returning();
  const token = generateSessionToken();
  await db.insert(sessions).values({
    userId: row!.id,
    tokenHash: hashSessionToken(token),
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
  });
  return { ...row!, token };
}

export async function createProduct(
  overrides: Partial<NewProduct> = {},
  stock: { onHand?: number; reserved?: number } = {},
): Promise<Product> {
  return db.transaction(async (tx) => {
    const [product] = await tx
      .insert(products)
      .values({
        sku: `SKU-${randomUUID().slice(0, 8).toUpperCase()}`,
        name: "Test Product",
        priceCents: 1999,
        status: "ACTIVE",
        ...overrides,
      })
      .returning();
    const initialOnHand = stock.onHand ?? 10;
    const initialReserved = stock.reserved ?? 0;
    await tx.insert(inventory).values({
      productId: product!.id,
      quantityOnHand: initialOnHand,
      quantityReserved: initialReserved,
    });
    if (initialOnHand > 0 || initialReserved > 0) {
      await tx.insert(inventoryMovements).values({
        productId: product!.id,
        deltaOnHand: initialOnHand,
        deltaReserved: initialReserved,
        reason: "INITIAL_STOCK",
        note: "Fixture initial stock",
      });
    }
    return product!;
  });
}

export async function createCart(userId: string, status: Cart["status"] = "ACTIVE"): Promise<Cart> {
  const [row] = await db.insert(carts).values({ userId, status }).returning();
  return row!;
}

export async function createOrderWithItem(user: User, product: Product, quantity = 1): Promise<Order> {
  const cart = await createCart(user.id, "CONVERTED");
  return db.transaction(async (tx) => {
    const lineTotal = quantity * product.priceCents;
    const [order] = await tx
      .insert(orders)
      .values({
        userId: user.id,
        cartId: cart.id,
        idempotencyKey: randomUUID(),
        requestFingerprint: "fp",
        totalCents: lineTotal,
        currency: product.currency,
      })
      .returning();
    await tx.insert(orderItems).values({
      orderId: order!.id,
      productId: product.id,
      quantity,
      unitPriceCentsSnapshot: product.priceCents,
      productNameSnapshot: product.name,
      skuSnapshot: product.sku,
      lineTotalCents: lineTotal,
    });
    return order!;
  });
}
