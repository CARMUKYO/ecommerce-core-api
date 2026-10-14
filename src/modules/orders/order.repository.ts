import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type { DbExecutor } from "../../db/client.js";
import { carts } from "../../db/schema/carts.js";
import { inventory } from "../../db/schema/inventory.js";
import {
  orderItems,
  orders,
  type NewOrder,
  type NewOrderItem,
  type Order,
  type OrderItem,
} from "../../db/schema/orders.js";

export interface OrderWithItems {
  order: Order;
  items: OrderItem[];
}

export class OrderRepository {
  async createOrder(executor: DbExecutor, data: NewOrder): Promise<Order> {
    const [row] = await executor.insert(orders).values(data).returning();
    return row!;
  }

  async createOrderItems(executor: DbExecutor, items: NewOrderItem[]): Promise<OrderItem[]> {
    return await executor.insert(orderItems).values(items).returning();
  }

  async findOrderById(executor: DbExecutor, id: string): Promise<Order | undefined> {
    const [row] = await executor.select().from(orders).where(eq(orders.id, id));
    return row;
  }

  async findOrderWithItems(executor: DbExecutor, id: string): Promise<OrderWithItems | undefined> {
    const [order] = await executor.select().from(orders).where(eq(orders.id, id));
    if (!order) return undefined;

    const items = await executor.select().from(orderItems).where(eq(orderItems.orderId, id));
    return { order, items };
  }

  async findOrderByUserAndIdempotencyKey(
    executor: DbExecutor,
    userId: string,
    key: string,
  ): Promise<OrderWithItems | undefined> {
    const [order] = await executor
      .select()
      .from(orders)
      .where(and(eq(orders.userId, userId), eq(orders.idempotencyKey, key)));
    if (!order) return undefined;

    const items = await executor.select().from(orderItems).where(eq(orderItems.orderId, order.id));
    return { order, items };
  }

  async listOrdersByUser(
    executor: DbExecutor,
    userId: string,
    opts: { limit: number; offset: number },
  ): Promise<{ orders: OrderWithItems[]; total: number }> {
    const userOrders = await executor
      .select()
      .from(orders)
      .where(eq(orders.userId, userId))
      .orderBy(desc(orders.createdAt))
      .limit(opts.limit)
      .offset(opts.offset);

    const countRows = await executor
      .select({ id: orders.id })
      .from(orders)
      .where(eq(orders.userId, userId));

    const results: OrderWithItems[] = [];
    for (const order of userOrders) {
      const items = await executor.select().from(orderItems).where(eq(orderItems.orderId, order.id));
      results.push({ order, items });
    }

    return { orders: results, total: countRows.length };
  }

  async compareAndSetStatus(
    executor: DbExecutor,
    id: string,
    allowedFrom: readonly Order["status"][],
    to: Order["status"],
    extraUpdates: Partial<NewOrder> = {},
  ): Promise<Order | undefined> {
    const [row] = await executor
      .update(orders)
      .set({
        status: to,
        ...extraUpdates,
      })
      .where(and(eq(orders.id, id), inArray(orders.status, allowedFrom as Order["status"][])))
      .returning();
    return row;
  }

  /**
   * Deterministic, deadlock-free row locking of inventory records.
   * sortedProductIds must be sorted lexicographically before calling.
   */
  async lockInventoryRows(
    executor: DbExecutor,
    sortedProductIds: string[],
  ): Promise<Map<string, { onHand: number; reserved: number; version: number }>> {
    const idList = sql.join(
      sortedProductIds.map((id) => sql`${id}`),
      sql`, `,
    );

    const result = await executor.execute(
      sql`SELECT product_id, quantity_on_hand, quantity_reserved, version
          FROM inventory
          WHERE product_id IN (${idList})
          ORDER BY product_id
          FOR UPDATE`,
    );

    const map = new Map<string, { onHand: number; reserved: number; version: number }>();
    for (const row of result.rows) {
      map.set(row.product_id as string, {
        onHand: Number(row.quantity_on_hand),
        reserved: Number(row.quantity_reserved),
        version: Number(row.version),
      });
    }
    return map;
  }

  async incrementReservedInventory(executor: DbExecutor, productId: string, quantity: number): Promise<void> {
    await executor
      .update(inventory)
      .set({
        quantityReserved: sql`${inventory.quantityReserved} + ${quantity}`,
        version: sql`${inventory.version} + 1`,
      })
      .where(eq(inventory.productId, productId));
  }

  async decrementReservedInventory(executor: DbExecutor, productId: string, quantity: number): Promise<void> {
    await executor
      .update(inventory)
      .set({
        quantityReserved: sql`${inventory.quantityReserved} - ${quantity}`,
        version: sql`${inventory.version} + 1`,
      })
      .where(eq(inventory.productId, productId));
  }

  async convertCartStatus(executor: DbExecutor, cartId: string): Promise<boolean> {
    const [row] = await executor
      .update(carts)
      .set({ status: "CONVERTED" })
      .where(and(eq(carts.id, cartId), eq(carts.status, "ACTIVE")))
      .returning();
    return !!row;
  }
}

export const orderRepository = new OrderRepository();
