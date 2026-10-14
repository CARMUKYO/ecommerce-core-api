import { createHash } from "node:crypto";
import { db, type Tx } from "../../db/client.js";
import { findPgError, PgErrorCodes } from "../../db/pg-errors.js";
import type { Order, OrderItem } from "../../db/schema/orders.js";
import type { User } from "../../db/schema/users.js";
import { AppError, ErrorCodes } from "../../http/errors.js";
import { cartRepository, type CartItemDetailed } from "../cart/cart.repository.js";
import { inventoryRepository } from "../inventory/inventory.repository.js";
import { canTransitionOrderStatus, getAllowedOrderStatusTargets, type OrderStatus } from "./order-status.js";
import { orderRepository, type OrderWithItems } from "./order.repository.js";

export interface FormattedOrderItem {
  id: string;
  productId: string;
  sku: string;
  productName: string;
  unitPriceCents: number;
  quantity: number;
  lineTotalCents: number;
}

export interface FormattedOrder {
  id: string;
  userId: string;
  cartId: string;
  idempotencyKey: string;
  status: Order["status"];
  totalCents: number;
  currency: string;
  createdAt: Date;
  updatedAt: Date;
  paidAt: Date | null;
  shippedAt: Date | null;
  cancelledAt: Date | null;
  items: FormattedOrderItem[];
}

export function formatOrderResponse(data: OrderWithItems): FormattedOrder {
  return {
    id: data.order.id,
    userId: data.order.userId,
    cartId: data.order.cartId,
    idempotencyKey: data.order.idempotencyKey,
    status: data.order.status,
    totalCents: data.order.totalCents,
    currency: data.order.currency,
    createdAt: data.order.createdAt,
    updatedAt: data.order.updatedAt,
    paidAt: data.order.paidAt,
    shippedAt: data.order.shippedAt,
    cancelledAt: data.order.cancelledAt,
    items: data.items.map((i: OrderItem) => ({
      id: i.id,
      productId: i.productId,
      sku: i.skuSnapshot,
      productName: i.productNameSnapshot,
      unitPriceCents: i.unitPriceCentsSnapshot,
      quantity: i.quantity,
      lineTotalCents: i.lineTotalCents,
    })),
  };
}

/** Records the cart contents that were purchased (audit only; not used to reject retries). */
function computeFingerprint(lines: CartItemDetailed[]): string {
  const sorted = lines
    .map((l) => ({ productId: l.item.productId, quantity: l.item.quantity }))
    .sort((a, b) => a.productId.localeCompare(b.productId));
  return createHash("sha256").update(JSON.stringify(sorted)).digest("hex");
}


export class OrderService {
  async checkout(actor: User, idempotencyKey?: string | undefined): Promise<{ order: FormattedOrder; replayed: boolean }> {
    if (!idempotencyKey || typeof idempotencyKey !== "string" || idempotencyKey.trim().length === 0) {
      throw new AppError({
        statusCode: 400,
        code: ErrorCodes.IDEMPOTENCY_KEY_REQUIRED,
        message: "An 'Idempotency-Key' header is required for checkout",
      });
    }

    const trimmedKey = idempotencyKey.trim();
    if (trimmedKey.length > 255) {
      throw new AppError({
        statusCode: 400,
        code: ErrorCodes.IDEMPOTENCY_KEY_REQUIRED,
        message: "Idempotency-Key header cannot exceed 255 characters",
      });
    }

    try {
      return await db.transaction(async (tx) => {
        // 1. Idempotency check: has an order already been created with this key?
        const existing = await orderRepository.findOrderByUserAndIdempotencyKey(tx, actor.id, trimmedKey);

        // The key identifies the *request*, not a cart state. Checkout has no
        // body, so any request with this (user, key) is a retry of the original:
        // replay the stored order (in its current status) regardless of what the
        // user's cart holds now. Read-only — no cart lock, no inventory touched.
        if (existing) {
          return { order: formatOrderResponse(existing), replayed: true };
        }

        // 2. Fetch active cart
        const activeCart = await cartRepository.findActiveCartByUserId(tx, actor.id);

        if (!activeCart) {
          throw new AppError({
            statusCode: 400,
            code: ErrorCodes.CART_EMPTY,
            message: "Cannot checkout: your cart has no items",
          });
        }

        // 3. Lock the cart row (lock order: cart -> inventory). This serializes
        // checkout against concurrent cart writes and competing checkouts.
        const cart = await cartRepository.lockCart(tx, activeCart.id);
        if (!cart || cart.status !== "ACTIVE") {
          // Another checkout converted this cart while we waited for the lock.
          // Same key -> it was our own concurrent retry: replay its order.
          const raced = await orderRepository.findOrderByUserAndIdempotencyKey(tx, actor.id, trimmedKey);
          if (raced) {
            return { order: formatOrderResponse(raced), replayed: true };
          }
          const winner = await orderRepository.findOrderByCartId(tx, activeCart.id);
          throw new AppError({
            statusCode: 409,
            code: ErrorCodes.CART_ALREADY_CHECKED_OUT,
            message: "This cart has already been checked out by another request",
            details: { cartId: activeCart.id, ...(winner ? { orderId: winner.id } : {}) },
          });
        }

        // Read lines only under the lock so the order matches the cart exactly.
        const lines = await cartRepository.findCartItemsWithDetails(tx, cart.id);
        if (lines.length === 0) {
          throw new AppError({
            statusCode: 400,
            code: ErrorCodes.CART_EMPTY,
            message: "Cannot checkout: your cart has no items",
          });
        }

        const fingerprint = computeFingerprint(lines);

        // 4. Deterministic deadlock-free sorting of product IDs
        const sortedProductIds = Array.from(new Set(lines.map((l) => l.item.productId))).sort();

        // 5. Acquire FOR UPDATE exclusive locks on inventory rows in sorted order
        const inventoryMap = await orderRepository.lockInventoryRows(tx, sortedProductIds);

        // 6. Verify product availability and live status
        for (const line of lines) {
          if (line.product.status !== "ACTIVE") {
            throw new AppError({
              statusCode: 409,
              code: ErrorCodes.PRODUCT_UNAVAILABLE,
              message: `Product '${line.product.name}' (${line.product.sku}) is no longer active and cannot be purchased`,
              details: { sku: line.product.sku, status: line.product.status },
            });
          }

          const inv = inventoryMap.get(line.item.productId);
          const available = inv ? inv.onHand - inv.reserved : 0;
          if (available < line.item.quantity) {
            throw new AppError({
              statusCode: 409,
              code: ErrorCodes.INSUFFICIENT_INVENTORY,
              message: `Requested ${line.item.quantity} units of SKU '${line.product.sku}', but only ${available} is available`,
              details: { sku: line.product.sku, requested: line.item.quantity, available },
            });
          }
        }

        // 7. Calculate order total cents
        const totalCents = lines.reduce((sum, l) => sum + l.item.quantity * l.product.priceCents, 0);

        // 8. Create Order record
        const order = await orderRepository.createOrder(tx, {
          userId: actor.id,
          cartId: cart.id,
          idempotencyKey: trimmedKey,
          requestFingerprint: fingerprint,
          totalCents,
          currency: "USD",
          status: "PENDING",
        });

        // 9. Reserve inventory, record audit movements, and snapshot order items
        const orderItemsToInsert = [];
        for (const line of lines) {
          await orderRepository.incrementReservedInventory(tx, line.item.productId, line.item.quantity);

          await inventoryRepository.insertMovement(tx, {
            productId: line.item.productId,
            deltaOnHand: 0,
            deltaReserved: line.item.quantity,
            reason: "ORDER_RESERVED",
            orderId: order.id,
            actorUserId: actor.id,
            note: `Order ${order.id} checkout reservation`,
          });

          orderItemsToInsert.push({
            orderId: order.id,
            productId: line.item.productId,
            quantity: line.item.quantity,
            unitPriceCentsSnapshot: line.product.priceCents,
            productNameSnapshot: line.product.name,
            skuSnapshot: line.product.sku,
            lineTotalCents: line.item.quantity * line.product.priceCents,
          });
        }

        const createdItems = await orderRepository.createOrderItems(tx, orderItemsToInsert);

        // 10. Convert cart status (cannot fail while we hold the cart lock)
        const converted = await orderRepository.convertCartStatus(tx, cart.id);
        if (!converted) {
          throw new Error(`Invariant violated: locked cart ${cart.id} was no longer ACTIVE at conversion`);
        }

        return {
          order: formatOrderResponse({ order, items: createdItems }),
          replayed: false,
        };
      });
    } catch (err: unknown) {
      // Concurrency race on idempotency key or cart: re-query existing order
      const pgErr = findPgError(err);
      if (pgErr?.code === PgErrorCodes.UNIQUE_VIOLATION) {
        const existing = await orderRepository.findOrderByUserAndIdempotencyKey(db, actor.id, trimmedKey);
        if (existing) {
          return { order: formatOrderResponse(existing), replayed: true };
        }
        if (pgErr.constraint === "orders_cart_id_key") {
          throw new AppError({
            statusCode: 409,
            code: ErrorCodes.CART_ALREADY_CHECKED_OUT,
            message: "This cart has already been checked out by another request",
          });
        }
      }
      throw err;
    }
  }

  /**
   * Customer or admin cancellation. Policy (#8): customers may cancel only
   * PENDING orders; PAID orders involve a refund and require an admin.
   */
  async cancelOrder(actor: User, orderId: string): Promise<{ order: FormattedOrder; alreadyCancelled: boolean }> {
    return await db.transaction(async (tx) => {
      const existing = await this.lockVisibleOrder(tx, actor, orderId);

      if (existing.order.status === "CANCELLED") {
        return { order: formatOrderResponse(existing), alreadyCancelled: true };
      }
      assertTransition(existing.order.status, "CANCELLED");

      if (existing.order.status === "PAID" && actor.role !== "ADMIN") {
        throw new AppError({
          statusCode: 403,
          code: ErrorCodes.CANCELLATION_REQUIRES_ADMIN,
          message: "Paid orders can only be cancelled by an administrator (a refund is required)",
          details: { status: existing.order.status },
        });
      }

      const order = await cancelLocked(tx, existing, actor.id, "Order cancelled");
      return { order: formatOrderResponse({ order, items: existing.items }), alreadyCancelled: false };
    });
  }

  /** Admin: PENDING -> PAID. Stock stays reserved until shipping. Idempotent. */
  async markPaid(actor: User, orderId: string): Promise<{ order: FormattedOrder; alreadyPaid: boolean }> {
    return await db.transaction(async (tx) => {
      const existing = await this.lockVisibleOrder(tx, actor, orderId);
      if (existing.order.status === "PAID") {
        return { order: formatOrderResponse(existing), alreadyPaid: true };
      }
      assertTransition(existing.order.status, "PAID");

      const order = await orderRepository.updateOrderStatus(tx, orderId, "PAID", { paidAt: new Date() });
      return { order: formatOrderResponse({ order, items: existing.items }), alreadyPaid: false };
    });
  }

  /** Admin: PAID -> SHIPPED. Reserved units leave the warehouse (on_hand -= q, reserved -= q). Idempotent. */
  async shipOrder(actor: User, orderId: string): Promise<{ order: FormattedOrder; alreadyShipped: boolean }> {
    return await db.transaction(async (tx) => {
      const existing = await this.lockVisibleOrder(tx, actor, orderId);
      if (existing.order.status === "SHIPPED") {
        return { order: formatOrderResponse(existing), alreadyShipped: true };
      }
      assertTransition(existing.order.status, "SHIPPED");

      await orderRepository.lockInventoryRows(tx, sortedProductIds(existing.items));
      for (const item of existing.items) {
        await orderRepository.shipReservedInventory(tx, item.productId, item.quantity);
        await inventoryRepository.insertMovement(tx, {
          productId: item.productId,
          deltaOnHand: -item.quantity,
          deltaReserved: -item.quantity,
          reason: "ORDER_SHIPPED",
          orderId,
          actorUserId: actor.id,
          note: "Order shipped",
        });
      }

      const order = await orderRepository.updateOrderStatus(tx, orderId, "SHIPPED", { shippedAt: new Date() });
      return { order: formatOrderResponse({ order, items: existing.items }), alreadyShipped: false };
    });
  }

  /**
   * Background job: cancel PENDING orders older than the TTL and release their
   * stock, so unpaid orders cannot hoard inventory. One short transaction per
   * order; each re-checks status under the row lock, so a concurrent payment
   * or cancellation always wins cleanly and stock is released exactly once.
   */
  async expirePendingOrders(opts: { ttlMinutes: number; batchSize?: number }): Promise<number> {
    const ids = await orderRepository.findExpiredPendingOrderIds(db, opts.ttlMinutes, opts.batchSize ?? 100);
    let expired = 0;
    for (const id of ids) {
      const done = await db.transaction(async (tx) => {
        const existing = await orderRepository.lockOrderWithItems(tx, id);
        if (existing?.order.status !== "PENDING") return false;
        await cancelLocked(tx, existing, null, `Expired: unpaid after ${opts.ttlMinutes} minutes`);
        return true;
      });
      if (done) expired++;
    }
    return expired;
  }

  async getOrderById(actor: User, orderId: string): Promise<FormattedOrder> {
    const existing = await orderRepository.findOrderWithItems(db, orderId);
    if (!existing || (actor.role !== "ADMIN" && existing.order.userId !== actor.id)) {
      throw orderNotFound(orderId);
    }
    return formatOrderResponse(existing);
  }

  async listOrders(actor: User, opts: { limit: number; offset: number }): Promise<{ orders: FormattedOrder[]; total: number }> {
    const result = await orderRepository.listOrders(db, { userId: actor.id, ...opts });
    return { orders: result.orders.map(formatOrderResponse), total: result.total };
  }

  /** Admin fulfillment view across all users. */
  async listAllOrders(opts: {
    status?: OrderStatus | undefined;
    userId?: string | undefined;
    limit: number;
    offset: number;
  }): Promise<{ orders: FormattedOrder[]; total: number }> {
    const result = await orderRepository.listOrders(db, opts);
    return { orders: result.orders.map(formatOrderResponse), total: result.total };
  }

  /** Lock the order row; non-admins only see their own orders (404 otherwise, never 403). */
  private async lockVisibleOrder(tx: Tx, actor: User, orderId: string): Promise<OrderWithItems> {
    const existing = await orderRepository.lockOrderWithItems(tx, orderId);
    if (!existing || (actor.role !== "ADMIN" && existing.order.userId !== actor.id)) {
      throw orderNotFound(orderId);
    }
    return existing;
  }
}

function orderNotFound(orderId: string): AppError {
  return new AppError({
    statusCode: 404,
    code: ErrorCodes.ORDER_NOT_FOUND,
    message: `Order with ID '${orderId}' was not found`,
  });
}

function assertTransition(from: OrderStatus, to: OrderStatus): void {
  if (canTransitionOrderStatus(from, to)) return;
  throw new AppError({
    statusCode: 409,
    code: ErrorCodes.INVALID_ORDER_STATE_TRANSITION,
    message:
      from === "SHIPPED" && to === "CANCELLED"
        ? "Shipped orders cannot be cancelled directly; requires a return flow"
        : `Cannot transition order from '${from}' to '${to}'`,
    details: { from, to, allowedTargets: getAllowedOrderStatusTargets(from) },
  });
}

function sortedProductIds(items: OrderItem[]): string[] {
  return Array.from(new Set(items.map((i) => i.productId))).sort();
}

/** Cancel a locked PENDING/PAID order and release its reserved stock. */
async function cancelLocked(tx: Tx, existing: OrderWithItems, actorUserId: string | null, note: string): Promise<Order> {
  await orderRepository.lockInventoryRows(tx, sortedProductIds(existing.items));
  for (const item of existing.items) {
    await orderRepository.decrementReservedInventory(tx, item.productId, item.quantity);
    await inventoryRepository.insertMovement(tx, {
      productId: item.productId,
      deltaOnHand: 0,
      deltaReserved: -item.quantity,
      reason: "ORDER_RELEASED",
      orderId: existing.order.id,
      actorUserId,
      note,
    });
  }
  return await orderRepository.updateOrderStatus(tx, existing.order.id, "CANCELLED", { cancelledAt: new Date() });
}

export const orderService = new OrderService();
