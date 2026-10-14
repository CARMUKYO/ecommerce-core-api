import { describe, expect, it } from "vitest";
import {
  canTransitionOrderStatus,
  getAllowedOrderStatusTargets,
  type OrderStatus,
} from "../../src/modules/orders/order-status.js";

describe("Order Status State Machine", () => {
  const all: OrderStatus[] = ["PENDING", "PAID", "SHIPPED", "CANCELLED"];
  const allowed: [OrderStatus, OrderStatus][] = [
    ["PENDING", "PAID"],
    ["PENDING", "CANCELLED"],
    ["PAID", "SHIPPED"],
    ["PAID", "CANCELLED"],
  ];

  it("allows exactly the documented transitions", () => {
    for (const from of all) {
      for (const to of all) {
        const expected = allowed.some(([f, t]) => f === from && t === to);
        expect(canTransitionOrderStatus(from, to), `${from} -> ${to}`).toBe(expected);
      }
    }
  });

  it("treats SHIPPED and CANCELLED as terminal", () => {
    expect(getAllowedOrderStatusTargets("SHIPPED")).toEqual([]);
    expect(getAllowedOrderStatusTargets("CANCELLED")).toEqual([]);
  });

  it("never allows going back to PENDING or skipping PAID", () => {
    for (const from of all) expect(canTransitionOrderStatus(from, "PENDING")).toBe(false);
    expect(canTransitionOrderStatus("PENDING", "SHIPPED")).toBe(false);
  });
});
