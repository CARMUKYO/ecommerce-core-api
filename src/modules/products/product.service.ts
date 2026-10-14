import { db } from "../../db/client.js";
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

export class ProductService {
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
      if ((err as { code?: string }).code === "23505") {
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
    const existing = await productRepository.findProductById(db, id);
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

    let normalizedSku: string | undefined;
    if (input.sku !== undefined) {
      normalizedSku = input.sku.trim().toUpperCase();
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

    try {
      await productRepository.updateProduct(db, id, updates);
    } catch (err: unknown) {
      if ((err as { code?: string }).code === "23505") {
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
    const existing = await productRepository.findProductByIdWithInventory(db, id);
    if (!existing) {
      throw new AppError({
        statusCode: 404,
        code: ErrorCodes.PRODUCT_NOT_FOUND,
        message: `Product with ID '${id}' was not found`,
      });
    }

    if (existing.product.status === "ACTIVE") {
      // Idempotent no-op
      return formatProductResponse(existing);
    }

    if (!canTransitionProductStatus(existing.product.status, "ACTIVE")) {
      throw new AppError({
        statusCode: 409,
        code: ErrorCodes.INVALID_PRODUCT_STATUS_TRANSITION,
        message: `Cannot transition product from '${existing.product.status}' to 'ACTIVE'`,
        details: {
          from: existing.product.status,
          to: "ACTIVE",
          allowedTargets: getAllowedProductStatusTargets(existing.product.status),
        },
      });
    }

    if (existing.product.priceCents <= 0) {
      throw new AppError({
        statusCode: 422,
        code: ErrorCodes.PRODUCT_NOT_ACTIVATABLE,
        message: "Product must have a price greater than 0 before activation",
        details: { violations: ["PRICE_MUST_BE_GREATER_THAN_ZERO"] },
      });
    }

    // Atomic compare-and-set: ensure status hasn't changed since we inspected it
    const allowedSources = [existing.product.status] as const;
    const updated = await productRepository.compareAndSetStatus(db, id, allowedSources, "ACTIVE");

    if (!updated) {
      // Transition raced with another update
      const reFetched = await productRepository.findProductById(db, id);
      throw new AppError({
        statusCode: 409,
        code: ErrorCodes.INVALID_PRODUCT_STATUS_TRANSITION,
        message: `Cannot transition product from '${reFetched?.status}' to 'ACTIVE'`,
        details: {
          from: reFetched?.status,
          to: "ACTIVE",
          allowedTargets: reFetched ? getAllowedProductStatusTargets(reFetched.status) : [],
        },
      });
    }

    const result = await productRepository.findProductByIdWithInventory(db, id);
    return formatProductResponse(result!);
  }

  async archiveProduct(_actor: User, id: string): Promise<FormattedProduct> {
    const existing = await productRepository.findProductByIdWithInventory(db, id);
    if (!existing) {
      throw new AppError({
        statusCode: 404,
        code: ErrorCodes.PRODUCT_NOT_FOUND,
        message: `Product with ID '${id}' was not found`,
      });
    }

    if (existing.product.status === "ARCHIVED") {
      // Idempotent no-op
      return formatProductResponse(existing);
    }

    if (!canTransitionProductStatus(existing.product.status, "ARCHIVED")) {
      throw new AppError({
        statusCode: 409,
        code: ErrorCodes.INVALID_PRODUCT_STATUS_TRANSITION,
        message: `Cannot transition product from '${existing.product.status}' to 'ARCHIVED'`,
        details: {
          from: existing.product.status,
          to: "ARCHIVED",
          allowedTargets: getAllowedProductStatusTargets(existing.product.status),
        },
      });
    }

    // Atomic compare-and-set: ensure status hasn't changed since we inspected it
    const allowedSources = [existing.product.status] as const;
    const updated = await productRepository.compareAndSetStatus(db, id, allowedSources, "ARCHIVED");

    if (!updated) {
      const reFetched = await productRepository.findProductById(db, id);
      throw new AppError({
        statusCode: 409,
        code: ErrorCodes.INVALID_PRODUCT_STATUS_TRANSITION,
        message: `Cannot transition product from '${reFetched?.status}' to 'ARCHIVED'`,
        details: {
          from: reFetched?.status,
          to: "ARCHIVED",
          allowedTargets: reFetched ? getAllowedProductStatusTargets(reFetched.status) : [],
        },
      });
    }

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
