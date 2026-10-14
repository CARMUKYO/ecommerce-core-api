import { and, eq, sql } from "drizzle-orm";
import type { DbExecutor } from "../../db/client.js";
import { cartItems, carts, type Cart, type CartItem } from "../../db/schema/carts.js";
import { inventory, type Inventory } from "../../db/schema/inventory.js";
import { products, type Product } from "../../db/schema/products.js";

export interface CartItemDetailed {
  item: CartItem;
  product: Product;
  inventory: Inventory;
}

export class CartRepository {
  async findActiveCartByUserId(executor: DbExecutor, userId: string): Promise<Cart | undefined> {
    const [row] = await executor
      .select()
      .from(carts)
      .where(and(eq(carts.userId, userId), eq(carts.status, "ACTIVE")));
    return row;
  }

  /**
   * Lock the user's ACTIVE cart row. Under READ COMMITTED, if a concurrent
   * checkout converts the cart while we wait, Postgres re-evaluates the WHERE
   * clause against the committed row and returns nothing.
   */
  async findActiveCartForUpdate(executor: DbExecutor, userId: string): Promise<Cart | undefined> {
    const [row] = await executor
      .select()
      .from(carts)
      .where(and(eq(carts.userId, userId), eq(carts.status, "ACTIVE")))
      .for("update");
    return row;
  }

  /** Lock a cart row by id, returning its current (post-wait) status. */
  async lockCart(executor: DbExecutor, cartId: string): Promise<Cart | undefined> {
    const [row] = await executor.select().from(carts).where(eq(carts.id, cartId)).for("update");
    return row;
  }

  async getOrCreateActiveCart(executor: DbExecutor, userId: string): Promise<Cart> {
    const existing = await this.findActiveCartByUserId(executor, userId);
    if (existing) return existing;

    // Use INSERT ON CONFLICT DO NOTHING to be race-safe
    const result = await executor.execute(
      sql`INSERT INTO carts (user_id, status)
          VALUES (${userId}, 'ACTIVE')
          ON CONFLICT (user_id) WHERE status = 'ACTIVE'
          DO NOTHING
          RETURNING id, user_id, status, created_at, updated_at`,
    );

    const inserted = result.rows[0];
    if (inserted) {
      return {
        id: inserted.id as string,
        userId: inserted.user_id as string,
        status: inserted.status as Cart["status"],
        createdAt: new Date(inserted.created_at as string | number),
        updatedAt: new Date(inserted.updated_at as string | number),
      };
    }

    // Winner of concurrent insert; retrieve it
    const active = await this.findActiveCartByUserId(executor, userId);
    return active!;
  }

  async findCartItemsWithDetails(executor: DbExecutor, cartId: string): Promise<CartItemDetailed[]> {
    const rows = await executor
      .select({
        item: cartItems,
        product: products,
        inventory: inventory,
      })
      .from(cartItems)
      .innerJoin(products, eq(cartItems.productId, products.id))
      .innerJoin(inventory, eq(products.id, inventory.productId))
      .where(eq(cartItems.cartId, cartId))
      .orderBy(cartItems.addedAt);

    return rows;
  }

  async findCartItem(
    executor: DbExecutor,
    cartId: string,
    productId: string,
  ): Promise<CartItem | undefined> {
    const [row] = await executor
      .select()
      .from(cartItems)
      .where(and(eq(cartItems.cartId, cartId), eq(cartItems.productId, productId)));
    return row;
  }

  async countCartItems(executor: DbExecutor, cartId: string): Promise<number> {
    const rows = await executor
      .select({ id: cartItems.id })
      .from(cartItems)
      .where(eq(cartItems.cartId, cartId));
    return rows.length;
  }

  /**
   * Atomically inserts a new line item or increments the existing quantity,
   * enforcing the quantity cap inside the atomic SQL statement.
   * Returns undefined if the resulting quantity would exceed maxLimit.
   */
  async upsertCartItemWithCap(
    executor: DbExecutor,
    cartId: string,
    productId: string,
    quantity: number,
    maxLimit: number,
  ): Promise<CartItem | undefined> {
    const result = await executor.execute(
      sql`INSERT INTO cart_items (cart_id, product_id, quantity)
          VALUES (${cartId}, ${productId}, ${quantity})
          ON CONFLICT (cart_id, product_id)
          DO UPDATE SET
            quantity = cart_items.quantity + EXCLUDED.quantity,
            updated_at = NOW()
          WHERE cart_items.quantity + EXCLUDED.quantity <= ${maxLimit}
          RETURNING id, cart_id, product_id, quantity, added_at, updated_at`,
    );

    const row = result.rows[0];
    if (!row) return undefined;

    return {
      id: row.id as string,
      cartId: row.cart_id as string,
      productId: row.product_id as string,
      quantity: Number(row.quantity),
      addedAt: new Date(row.added_at as string | number),
      updatedAt: new Date(row.updated_at as string | number),
    };
  }

  async updateCartItemQuantity(
    executor: DbExecutor,
    cartId: string,
    productId: string,
    quantity: number,
  ): Promise<CartItem | undefined> {
    const [row] = await executor
      .update(cartItems)
      .set({ quantity })
      .where(and(eq(cartItems.cartId, cartId), eq(cartItems.productId, productId)))
      .returning();
    return row;
  }

  async deleteCartItem(executor: DbExecutor, cartId: string, productId: string): Promise<boolean> {
    const rows = await executor
      .delete(cartItems)
      .where(and(eq(cartItems.cartId, cartId), eq(cartItems.productId, productId)))
      .returning({ id: cartItems.id });
    return rows.length > 0;
  }

  async clearCart(executor: DbExecutor, cartId: string): Promise<void> {
    await executor.delete(cartItems).where(eq(cartItems.cartId, cartId));
  }
}

export const cartRepository = new CartRepository();
