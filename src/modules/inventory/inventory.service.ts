import { createHash } from "node:crypto";
import { db } from "../../db/client.js";
import type { Inventory, InventoryMovement } from "../../db/schema/inventory.js";
import type { User } from "../../db/schema/users.js";
import { AppError, ErrorCodes } from "../../http/errors.js";
import { productRepository } from "../products/product.repository.js";
import { inventoryRepository } from "./inventory.repository.js";
import type { AdjustInventoryInput } from "./inventory.schemas.js";

export interface AdjustmentResult {
  inventory: {
    quantityOnHand: number;
    quantityReserved: number;
    availableQuantity: number;
    inStock: boolean;
    version: number;
  };
  movement: InventoryMovement;
  replayed: boolean;
}

export function formatInventoryResponse(inv: Inventory) {
  const available = Math.max(0, inv.quantityOnHand - inv.quantityReserved);
  return {
    quantityOnHand: inv.quantityOnHand,
    quantityReserved: inv.quantityReserved,
    availableQuantity: available,
    inStock: available > 0,
    version: inv.version,
  };
}

export class InventoryService {
  async adjustInventory(
    actor: User,
    productId: string,
    input: AdjustInventoryInput,
    idempotencyKey?: string | undefined,
  ): Promise<AdjustmentResult> {
    if (!idempotencyKey || typeof idempotencyKey !== "string" || idempotencyKey.trim().length === 0) {
      throw new AppError({
        statusCode: 400,
        code: ErrorCodes.IDEMPOTENCY_KEY_REQUIRED,
        message: "An 'Idempotency-Key' header is required for inventory adjustments",
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

    // Verify product exists
    const product = await productRepository.findProductById(db, productId);
    if (!product) {
      throw new AppError({
        statusCode: 404,
        code: ErrorCodes.PRODUCT_NOT_FOUND,
        message: `Product with ID '${productId}' was not found`,
      });
    }

    const normalizedNote = input.note.trim();
    const fingerprint = createHash("sha256")
      .update(JSON.stringify({ delta: input.delta, note: normalizedNote }))
      .digest("hex");

    return await db.transaction(async (tx) => {
      // 1. Lock inventory row for update
      const current = await inventoryRepository.getInventoryForUpdate(tx, productId);
      if (!current) {
        throw new AppError({
          statusCode: 404,
          code: ErrorCodes.PRODUCT_NOT_FOUND,
          message: `Inventory for product '${productId}' was not found`,
        });
      }

      // 2. Check for existing movement under this idempotency key
      const existingMovement = await inventoryRepository.findMovementByIdempotencyKey(tx, productId, trimmedKey);
      if (existingMovement) {
        if (existingMovement.requestFingerprint === fingerprint) {
          // Idempotent replay: return existing movement and current inventory state
          return {
            inventory: formatInventoryResponse(current),
            movement: existingMovement,
            replayed: true,
          };
        }

        // Same key, different payload -> 422
        throw new AppError({
          statusCode: 422,
          code: ErrorCodes.IDEMPOTENCY_KEY_REUSED,
          message: "The provided Idempotency-Key has already been used with different adjustment parameters",
          details: {
            idempotencyKey: trimmedKey,
            originalDelta: existingMovement.deltaOnHand,
            requestedDelta: input.delta,
          },
        });
      }

      // 3. Invariant checks
      const newOnHand = current.quantityOnHand + input.delta;
      if (newOnHand < 0) {
        throw new AppError({
          statusCode: 409,
          code: ErrorCodes.NEGATIVE_STOCK,
          message: "Adjustment would reduce inventory on hand below 0",
          details: {
            onHand: current.quantityOnHand,
            requestedDelta: input.delta,
          },
        });
      }

      if (newOnHand < current.quantityReserved) {
        const maxDecrease = current.quantityOnHand - current.quantityReserved;
        throw new AppError({
          statusCode: 409,
          code: ErrorCodes.STOCK_BELOW_RESERVED,
          message: `Cannot reduce stock below reserved quantity (${current.quantityReserved}). Maximum allowed decrease is ${maxDecrease}`,
          details: {
            onHand: current.quantityOnHand,
            reserved: current.quantityReserved,
            requestedDelta: input.delta,
            maxDecrease,
          },
        });
      }

      if (newOnHand > 1_000_000) {
        throw new AppError({
          statusCode: 422,
          code: ErrorCodes.STOCK_LIMIT_EXCEEDED,
          message: "Inventory on hand cannot exceed 1,000,000 units",
          details: { newOnHand },
        });
      }

      // 4. Update inventory and insert movement
      const updated = await inventoryRepository.updateInventoryOnHand(tx, productId, newOnHand);
      const movement = await inventoryRepository.insertMovement(tx, {
        productId,
        deltaOnHand: input.delta,
        deltaReserved: 0,
        reason: "ADMIN_ADJUSTMENT",
        actorUserId: actor.id,
        note: normalizedNote,
        idempotencyKey: trimmedKey,
        requestFingerprint: fingerprint,
      });

      return {
        inventory: formatInventoryResponse(updated!),
        movement,
        replayed: false,
      };
    });
  }

  async listMovements(
    productId: string,
    opts: { limit: number; offset: number },
  ): Promise<{ items: InventoryMovement[]; total: number }> {
    const product = await productRepository.findProductById(db, productId);
    if (!product) {
      throw new AppError({
        statusCode: 404,
        code: ErrorCodes.PRODUCT_NOT_FOUND,
        message: `Product with ID '${productId}' was not found`,
      });
    }

    return await inventoryRepository.listMovements(db, productId, opts);
  }
}

export const inventoryService = new InventoryService();
