import type { Order } from "../../db/schema/orders.js";

export type OrderStatus = Order["status"];

/**
 * The order state machine. SHIPPED and CANCELLED are terminal; SHIPPED orders
 * need a (future) return flow rather than cancellation.
 */
const ALLOWED_TRANSITIONS: Record<OrderStatus, readonly OrderStatus[]> = {
  PENDING: ["PAID", "CANCELLED"],
  PAID: ["SHIPPED", "CANCELLED"],
  SHIPPED: [],
  CANCELLED: [],
};

export function canTransitionOrderStatus(from: OrderStatus, to: OrderStatus): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to);
}

export function getAllowedOrderStatusTargets(from: OrderStatus): readonly OrderStatus[] {
  return ALLOWED_TRANSITIONS[from];
}
