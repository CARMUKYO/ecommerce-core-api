import type { Product } from "../../db/schema/products.js";

export type ProductStatus = Product["status"];

const ALLOWED_TRANSITIONS: Record<ProductStatus, readonly ProductStatus[]> = {
  DRAFT: ["ACTIVE", "ARCHIVED"],
  ACTIVE: ["ARCHIVED"],
  ARCHIVED: ["ACTIVE"],
};

export function canTransitionProductStatus(from: ProductStatus, to: ProductStatus): boolean {
  if (from === to) return true; // Idempotent no-op
  return ALLOWED_TRANSITIONS[from].includes(to);
}

export function getAllowedProductStatusTargets(from: ProductStatus): readonly ProductStatus[] {
  return ALLOWED_TRANSITIONS[from];
}
