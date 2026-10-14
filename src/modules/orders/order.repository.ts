import { and, count, desc, eq, inArray, lt, sql, type SQL } from "drizzle-orm";
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
import type { OrderStatus } from "./order-status.js";

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

  async findOrderByCartId(executor: DbExecutor, cartId: string): Promise<Order | undefined> {
    const [row] = await executor.select().from(orders).where(eq(orders.cartId, cartId));
    return row;
  }

  /**
   * Paginated orders with their items: one page query, one items query
   * (no N+1), and a real count(*). `id` breaks createdAt ties so pages are stable.
   */
  async listOrders(
    executor: DbExecutor,
    opts: { userId?: string | undefined; status?: OrderStatus | undefined; limit: number; offset: number },
  ): Promise<{ orders: OrderWithItems[]; total: number }> {
    const conditions: SQL[] = [];
    if (opts.userId) conditions.push(eq(orders.userId, opts.userId));
    if (opts.status) conditions.push(eq(orders.status, opts.status));
    const where = conditions.length > 0 ? and(...conditions) : undefined;

    const page = await executor
      .select()
      .from(orders)
      .where(where)
      .orderBy(desc(orders.createdAt), desc(orders.id))
      .limit(opts.limit)
      .offset(opts.offset);

    const [countRow] = await executor.select({ total: count() }).from(orders).where(where);

    const items =
      page.length > 0
        ? await executor
            .select()
            .from(orderItems)
            .where(inArray(orderItems.orderId, page.map((o) => o.id)))
            .orderBy(orderItems.id)
        : [];
    const itemsByOrder = new Map<string, OrderItem[]>();
    for (const item of items) {
      const list = itemsByOrder.get(item.orderId) ?? [];
      list.push(item);
      itemsByOrder.set(item.orderId, list);
    }

    return {
      orders: page.map((order) => ({ order, items: itemsByOrder.get(order.id) ?? [] })),
      total: countRow?.total ?? 0,
    };
  }

  /** Lock an order row for a status transition. Lock order: order -> inventory. */
  async lockOrderWithItems(executor: DbExecutor, id: string): Promise<OrderWithItems | undefined> {
    const [order] = await executor.select().from(orders).where(eq(orders.id, id)).for("update");
    if (!order) return undefined;
    const items = await executor.select().from(orderItems).where(eq(orderItems.orderId, id)).orderBy(orderItems.id);
    return { order, items };
  }

  async updateOrderStatus(
    executor: DbExecutor,
    id: string,
    to: OrderStatus,
    timestamps: Pick<Partial<NewOrder>, "paidAt" | "shippedAt" | "cancelledAt">,
  ): Promise<Order> {
    const [row] = await executor
      .update(orders)
      .set({ status: to, ...timestamps })
      .where(eq(orders.id, id))
      .returning();
    return row!;
  }

  /** PENDING orders older than the TTL (by DB clock), oldest first. Unlocked: callers re-check under lock. */
  async findExpiredPendingOrderIds(executor: DbExecutor, ttlMinutes: number, limit: number): Promise<string[]> {
    const rows = await executor
      .select({ id: orders.id })
      .from(orders)
      .where(
        and(
          eq(orders.status, "PENDING"),
          lt(orders.createdAt, sql`now() - make_interval(mins => ${ttlMinutes}::int)`),
        ),
      )
      .orderBy(orders.createdAt)
      .limit(limit);
    return rows.map((r) => r.id);
  }

  async isOrderExpired(executor: DbExecutor, id: string, ttlMinutes: number): Promise<boolean> {
    const [row] = await executor
      .select({ id: orders.id })
      .from(orders)
      .where(and(eq(orders.id, id), lt(orders.createdAt, sql`now() - make_interval(mins => ${ttlMinutes}::int)`)));
    return !!row;
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

  /** Shipping: units physically leave the warehouse and are no longer reserved. */
  async shipReservedInventory(executor: DbExecutor, productId: string, quantity: number): Promise<void> {
    await executor
      .update(inventory)
      .set({
        quantityOnHand: sql`${inventory.quantityOnHand} - ${quantity}`,
        quantityReserved: sql`${inventory.quantityReserved} - ${quantity}`,
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
