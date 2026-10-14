import { describe, expect, it } from "vitest";
import {
  canTransitionProductStatus,
  getAllowedProductStatusTargets,
  type ProductStatus,
} from "../../src/modules/products/product-status.js";

describe("Product Status State Machine", () => {
  const allStatuses: ProductStatus[] = ["DRAFT", "ACTIVE", "ARCHIVED"];

  it("allows idempotent same-status transitions (no-ops)", () => {
    for (const s of allStatuses) {
      expect(canTransitionProductStatus(s, s)).toBe(true);
    }
  });

  it("allows valid forward transitions", () => {
    expect(canTransitionProductStatus("DRAFT", "ACTIVE")).toBe(true);
    expect(canTransitionProductStatus("DRAFT", "ARCHIVED")).toBe(true);
    expect(canTransitionProductStatus("ACTIVE", "ARCHIVED")).toBe(true);
  });

  it("allows re-listing from ARCHIVED to ACTIVE", () => {
    expect(canTransitionProductStatus("ARCHIVED", "ACTIVE")).toBe(true);
  });

  it("disallows illegal transitions back to DRAFT", () => {
    expect(canTransitionProductStatus("ACTIVE", "DRAFT")).toBe(false);
    expect(canTransitionProductStatus("ARCHIVED", "DRAFT")).toBe(false);
  });

  it("provides correct allowed targets for each status", () => {
    expect(getAllowedProductStatusTargets("DRAFT")).toEqual(["ACTIVE", "ARCHIVED"]);
    expect(getAllowedProductStatusTargets("ACTIVE")).toEqual(["ARCHIVED"]);
    expect(getAllowedProductStatusTargets("ARCHIVED")).toEqual(["ACTIVE"]);
  });
});
