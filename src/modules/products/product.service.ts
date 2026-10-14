import { db } from "../../db/client.js";
import { isUniqueViolation } from "../../db/pg-errors.js";
import type { Product } from "../../db/schema/products.js";
import type { User } from "../../db/schema/users.js";
import { AppError, ErrorCodes } from "../../http/errors.js";
import { inventoryRepository } from "../inventory/inventory.repository.js";
import {
  canTransitionProductStatus,
  getAllowedProductStatusTargets,
  type ProductStatus,
} from "./product-status.js";
import {
  productRepository,
  type ProductWithInventory,
} from "./product.repository.js";
import type {
  CreateProductInput,
  UpdateProductInput,
} from "./product.schemas.js";

export interface FormattedProduct {
  id: string;
  sku: string;
  name: string;
  description: string;
  priceCents: number;
  currency: string;
  status: ProductStatus;
  createdAt: Date;
  updatedAt: Date;
  inventory: {
    quantityOnHand: number;
    quantityReserved: number;
    availableQuantity: number;
    inStock: boolean;
    version: number;
  };
}

export function formatProductResponse(item: ProductWithInventory): FormattedProduct {
  const onHand = item.inventory.quantityOnHand;
  const reserved = item.inventory.quantityReserved;
  const available = Math.max(0, onHand - reserved);

  return {
    id: item.product.id,
    sku: item.product.sku,
    name: item.product.name,
    description: item.product.description,
    priceCents: item.product.priceCents,
    currency: item.product.currency,
    status: item.product.status,
    createdAt: item.product.createdAt,
    updatedAt: item.product.updatedAt,
    inventory: {
      quantityOnHand: onHand,
      quantityReserved: reserved,
      availableQuantity: available,
      inStock: available > 0,
      version: item.inventory.version,
    },
  };
}

/**
 * Public catalog view. Built as an explicit allowlist so new internal fields
 * can never leak by default. On-hand and reserved counts (which reveal sales
 * velocity) and the inventory version token are admin-only.
 */
export interface PublicProduct {
  id: string;
  sku: string;
  name: string;
  description: string;
  priceCents: number;
  currency: string;
  status: ProductStatus;
  createdAt: Date;
  updatedAt: Date;
  inventory: {
    availableQuantity: number;
    inStock: boolean;
  };
}

export function toPublicProduct(p: FormattedProduct): PublicProduct {
  return {
    id: p.id,
    sku: p.sku,
    name: p.name,
    description: p.description,
    priceCents: p.priceCents,
    currency: p.currency,
    status: p.status,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
    inventory: {
      availableQuantity: p.inventory.availableQuantity,
      inStock: p.inventory.inStock,
    },
  };
}

export class ProductService {
  async getPublicProductById(id: string): Promise<PublicProduct> {
    return toPublicProduct(await this.getProductById(id, { mustBeActive: true }));
  }

  async listPublicProducts(opts: { limit: number; offset: number }): Promise<{ items: PublicProduct[]; total: number }> {
    const result = await this.listProducts({ mustBeActive: true, ...opts });
    return { items: result.items.map(toPublicProduct), total: result.total };
  }

  async createProduct(actor: User, input: CreateProductInput): Promise<FormattedProduct> {
    const normalizedSku = input.sku.trim().toUpperCase();

    try {
      return await db.transaction(async (tx) => {
        const product = await productRepository.createProduct(tx, {
          sku: normalizedSku,
          name: input.name.trim(),
          description: input.description ?? "",
          priceCents: input.priceCents,
          currency: input.currency ?? "USD",
          status: "DRAFT",
        });

        const inv = await inventoryRepository.createInventory(tx, {
          productId: product.id,
          quantityOnHand: input.initialStock ?? 0,
          quantityReserved: 0,
        });

        if (input.initialStock && input.initialStock > 0) {
          await inventoryRepository.insertMovement(tx, {
            productId: product.id,
            deltaOnHand: input.initialStock,
            deltaReserved: 0,
            reason: "INITIAL_STOCK",
            actorUserId: actor.id,
            note: "Initial stock allocation",
          });
        }

        return formatProductResponse({ product, inventory: inv });
      });
    } catch (err: unknown) {
      if (isUniqueViolation(err, "products_sku_key")) {
        throw new AppError({
          statusCode: 409,
          code: ErrorCodes.SKU_ALREADY_EXISTS,
          message: `A product with SKU '${normalizedSku}' already exists`,
          details: { sku: normalizedSku },
        });
      }
      throw err;
    }
  }

  async updateProduct(actor: User, id: string, input: UpdateProductInput): Promise<FormattedProduct> {
    const normalizedSku = input.sku?.trim().toUpperCase();

    try {
      await db.transaction(async (tx) => {
        // Lock the row so the status checks below hold until our UPDATE commits
        // (an activate/archive cannot slip in between check and write).
        const existing = await productRepository.lockProductForUpdate(tx, id);
        if (!existing) {
          throw new AppError({
            statusCode: 404,
            code: ErrorCodes.PRODUCT_NOT_FOUND,
            message: `Product with ID '${id}' was not found`,
          });
        }

        if (existing.status === "ARCHIVED") {
          throw new AppError({
            statusCode: 409,
            code: ErrorCodes.PRODUCT_NOT_EDITABLE,
            message: "Cannot edit an archived product",
          });
        }

        if (normalizedSku !== undefined) {
          if (existing.status !== "DRAFT" && normalizedSku !== existing.sku) {
            throw new AppError({
              statusCode: 409,
              code: ErrorCodes.SKU_IMMUTABLE,
              message: "SKU cannot be modified once a product has left DRAFT status",
              details: { currentSku: existing.sku, attemptedSku: normalizedSku },
            });
          }
        }

        if (existing.status === "ACTIVE" && input.priceCents !== undefined && input.priceCents <= 0) {
          throw new AppError({
            statusCode: 422,
            code: ErrorCodes.PRODUCT_NOT_ACTIVATABLE,
            message: "Active products must have a price greater than 0 cents",
            details: { violations: ["PRICE_MUST_BE_GREATER_THAN_ZERO"] },
          });
        }

        const updates: Record<string, unknown> = {};
        if (input.name !== undefined) updates["name"] = input.name.trim();
        if (input.description !== undefined) updates["description"] = input.description;
        if (input.priceCents !== undefined) updates["priceCents"] = input.priceCents;
        if (normalizedSku !== undefined) updates["sku"] = normalizedSku;

        await productRepository.updateProduct(tx, id, updates);
      });
    } catch (err: unknown) {
      if (isUniqueViolation(err, "products_sku_key")) {
        throw new AppError({
          statusCode: 409,
          code: ErrorCodes.SKU_ALREADY_EXISTS,
          message: `A product with SKU '${normalizedSku}' already exists`,
          details: { sku: normalizedSku },
        });
      }
      throw err;
    }

    const updated = await productRepository.findProductByIdWithInventory(db, id);
    return formatProductResponse(updated!);
  }

  async activateProduct(_actor: User, id: string): Promise<FormattedProduct> {
    return await this.transitionStatus(id, "ACTIVE", (product) => {
      if (product.priceCents <= 0) {
        throw new AppError({
          statusCode: 422,
          code: ErrorCodes.PRODUCT_NOT_ACTIVATABLE,
          message: "Product must have a price greater than 0 before activation",
          details: { violations: ["PRICE_MUST_BE_GREATER_THAN_ZERO"] },
        });
      }
    });
  }

  async archiveProduct(_actor: User, id: string): Promise<FormattedProduct> {
    return await this.transitionStatus(id, "ARCHIVED");
  }

  /**
   * Status change under an exclusive row lock, so preconditions (e.g. price > 0)
   * are checked against the same row state the update applies to. Repeating the
   * current status is an idempotent no-op.
   *
   * Contract preserved from the original compare-and-set: the transition acts on
   * the status the request *observed*. If a concurrent command changed it while
   * we waited for the lock, we fail with 409 instead of applying our transition
   * to a state the caller never saw.
   */
  private async transitionStatus(
    id: string,
    to: ProductStatus,
    precondition?: (product: Product) => void,
  ): Promise<FormattedProduct> {
    const observed = await productRepository.findProductById(db, id);
    if (!observed) {
      throw new AppError({
        statusCode: 404,
        code: ErrorCodes.PRODUCT_NOT_FOUND,
        message: `Product with ID '${id}' was not found`,
      });
    }

    await db.transaction(async (tx) => {
      const product = await productRepository.lockProductForUpdate(tx, id);
      if (!product) {
        throw new AppError({
          statusCode: 404,
          code: ErrorCodes.PRODUCT_NOT_FOUND,
          message: `Product with ID '${id}' was not found`,
        });
      }
      if (product.status === to && observed.status === to) return;

      if (product.status !== observed.status) {
        throw new AppError({
          statusCode: 409,
          code: ErrorCodes.INVALID_PRODUCT_STATUS_TRANSITION,
          message: `Cannot transition product from '${product.status}' to '${to}'; it changed concurrently`,
          details: { from: product.status, to, allowedTargets: getAllowedProductStatusTargets(product.status) },
        });
      }

      if (!canTransitionProductStatus(product.status, to)) {
        throw new AppError({
          statusCode: 409,
          code: ErrorCodes.INVALID_PRODUCT_STATUS_TRANSITION,
          message: `Cannot transition product from '${product.status}' to '${to}'`,
          details: { from: product.status, to, allowedTargets: getAllowedProductStatusTargets(product.status) },
        });
      }
      precondition?.(product);
      await productRepository.updateProduct(tx, id, { status: to });
    });

    const result = await productRepository.findProductByIdWithInventory(db, id);
    return formatProductResponse(result!);
  }

  async getProductById(id: string, opts?: { mustBeActive?: boolean }): Promise<FormattedProduct> {
    const item = await productRepository.findProductByIdWithInventory(db, id);
    if (!item) {
      throw new AppError({
        statusCode: 404,
        code: ErrorCodes.PRODUCT_NOT_FOUND,
        message: `Product with ID '${id}' was not found`,
      });
    }

    if (opts?.mustBeActive && item.product.status !== "ACTIVE") {
      // Do not disclose DRAFT or ARCHIVED products on public routes
      throw new AppError({
        statusCode: 404,
        code: ErrorCodes.PRODUCT_NOT_FOUND,
        message: `Product with ID '${id}' was not found`,
      });
    }

    return formatProductResponse(item);
  }

  async listProducts(opts: {
    mustBeActive?: boolean;
    status?: ProductStatus | undefined;
    limit: number;
    offset: number;
  }): Promise<{ items: FormattedProduct[]; total: number }> {
    const targetStatus = opts.mustBeActive ? "ACTIVE" : opts.status;
    const result = await productRepository.listProductsWithInventory(db, {
      status: targetStatus,
      limit: opts.limit,
      offset: opts.offset,
    });

    return {
      items: result.items.map(formatProductResponse),
      total: result.total,
    };
  }
}

export const productService = new ProductService();
