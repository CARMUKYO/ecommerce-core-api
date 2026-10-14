import { createHash } from "node:crypto";
import { db } from "../../db/client.js";
import type { Order, OrderItem } from "../../db/schema/orders.js";
import type { User } from "../../db/schema/users.js";
import { AppError, ErrorCodes } from "../../http/errors.js";
import { cartRepository, type CartItemDetailed } from "../cart/cart.repository.js";
import { inventoryRepository } from "../inventory/inventory.repository.js";
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

function computeFingerprint(lines: CartItemDetailed[]): string {
  const sorted = lines
    .map((l) => ({ productId: l.item.productId, quantity: l.item.quantity }))
    .sort((a, b) => a.productId.localeCompare(b.productId));
  return createHash("sha256").update(JSON.stringify(sorted)).digest("hex");
}

function findPgError(err: unknown): { code?: string; constraint?: string } | undefined {
  let current: unknown = err;
  for (let depth = 0; depth < 5 && current && typeof current === "object"; depth++) {
    const e = current as { code?: string; constraint?: string; cause?: unknown };
    if (typeof e.code === "string" && /^[0-9A-Z]{5}$/.test(e.code)) return e;
    current = e.cause;
  }
  return undefined;
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

        // 2. Fetch active cart
        const cart = await cartRepository.findActiveCartByUserId(tx, actor.id);
        const lines = cart ? await cartRepository.findCartItemsWithDetails(tx, cart.id) : [];

        if (existing) {
          // If the user has an active cart with items, ensure it's not key reuse for a new payload
          if (lines.length > 0) {
            const fingerprint = computeFingerprint(lines);
            if (existing.order.requestFingerprint !== fingerprint) {
              throw new AppError({
                statusCode: 422,
                code: ErrorCodes.IDEMPOTENCY_KEY_REUSED,
                message: "The provided Idempotency-Key has already been used with a different cart payload",
              });
            }
          }
          // Network retry of converted cart: replay existing order
          return { order: formatOrderResponse(existing), replayed: true };
        }

        if (!cart || lines.length === 0) {
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

        // 10. Convert cart status
        await orderRepository.convertCartStatus(tx, cart.id);

        return {
          order: formatOrderResponse({ order, items: createdItems }),
          replayed: false,
        };
      });
    } catch (err: unknown) {
      // Concurrency race on idempotency key or cart: re-query existing order
      const pgErr = findPgError(err);
      if (pgErr?.code === "23505") {
        const existing = await orderRepository.findOrderByUserAndIdempotencyKey(db, actor.id, trimmedKey);
        if (existing) {
          return { order: formatOrderResponse(existing), replayed: true };
        }
      }
      throw err;
    }
  }

  async cancelOrder(actor: User, orderId: string): Promise<{ order: FormattedOrder; alreadyCancelled: boolean }> {
    return await db.transaction(async (tx) => {
      // 1. Fetch order with items
      const existing = await orderRepository.findOrderWithItems(tx, orderId);
      if (!existing || (actor.role !== "ADMIN" && existing.order.userId !== actor.id)) {
        throw new AppError({
          statusCode: 404,
          code: ErrorCodes.ORDER_NOT_FOUND,
          message: `Order with ID '${orderId}' was not found`,
        });
      }

      // 2. Idempotent no-op if already cancelled
      if (existing.order.status === "CANCELLED") {
        return { order: formatOrderResponse(existing), alreadyCancelled: true };
      }

      // 3. Shipped orders cannot be cancelled
      if (existing.order.status === "SHIPPED") {
        throw new AppError({
          statusCode: 409,
          code: ErrorCodes.INVALID_ORDER_STATE_TRANSITION,
          message: "Shipped orders cannot be cancelled directly; requires a return flow",
        });
      }

      if (existing.order.status !== "PENDING" && existing.order.status !== "PAID") {
        throw new AppError({
          statusCode: 409,
          code: ErrorCodes.INVALID_ORDER_STATE_TRANSITION,
          message: `Cannot cancel order in status '${existing.order.status}'`,
        });
      }

      // 4. Atomic compare-and-set
      const updatedOrder = await orderRepository.compareAndSetStatus(
        tx,
        orderId,
        ["PENDING", "PAID"],
        "CANCELLED",
        { cancelledAt: new Date() },
      );

      if (!updatedOrder) {
        // Concurrently cancelled
        const current = await orderRepository.findOrderWithItems(tx, orderId);
        if (current?.order.status === "CANCELLED") {
          return { order: formatOrderResponse(current), alreadyCancelled: true };
        }
        throw new AppError({
          statusCode: 409,
          code: ErrorCodes.INVALID_ORDER_STATE_TRANSITION,
          message: `Cannot cancel order in status '${current?.order.status}'`,
        });
      }

      // 5. Restore reserved inventory and record movements
      const sortedProductIds = Array.from(new Set(existing.items.map((i) => i.productId))).sort();
      await orderRepository.lockInventoryRows(tx, sortedProductIds);

      for (const item of existing.items) {
        await orderRepository.decrementReservedInventory(tx, item.productId, item.quantity);

        await inventoryRepository.insertMovement(tx, {
          productId: item.productId,
          deltaOnHand: 0,
          deltaReserved: -item.quantity,
          reason: "ORDER_RELEASED",
          orderId: existing.order.id,
          actorUserId: actor.id,
          note: "Order cancelled",
        });
      }

      return {
        order: formatOrderResponse({ order: updatedOrder, items: existing.items }),
        alreadyCancelled: false,
      };
    });
  }

  async getOrderById(actor: User, orderId: string): Promise<FormattedOrder> {
    const existing = await orderRepository.findOrderWithItems(db, orderId);
    if (!existing || (actor.role !== "ADMIN" && existing.order.userId !== actor.id)) {
      throw new AppError({
        statusCode: 404,
        code: ErrorCodes.ORDER_NOT_FOUND,
        message: `Order with ID '${orderId}' was not found`,
      });
    }

    return formatOrderResponse(existing);
  }

  async listOrders(actor: User, opts: { limit: number; offset: number }): Promise<{ orders: FormattedOrder[]; total: number }> {
    const result = await orderRepository.listOrdersByUser(db, actor.id, opts);
    return {
      orders: result.orders.map(formatOrderResponse),
      total: result.total,
    };
  }
}

export const orderService = new OrderService();
