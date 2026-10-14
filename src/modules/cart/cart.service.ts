import { env } from "../../config/env.js";
import { db } from "../../db/client.js";
import { AppError, ErrorCodes } from "../../http/errors.js";
import { inventoryRepository } from "../inventory/inventory.repository.js";
import { productRepository } from "../products/product.repository.js";
import { cartRepository, type CartItemDetailed } from "./cart.repository.js";
import type { AddToCartInput } from "./cart.schemas.js";

export const MAX_DISTINCT_CART_ITEMS = 50;

export type CartItemIssue = "PRODUCT_UNAVAILABLE" | "OUT_OF_STOCK" | "PARTIALLY_AVAILABLE";

export interface FormattedCartItem {
  productId: string;
  sku: string;
  name: string;
  unitPriceCents: number;
  currency: string;
  quantity: number;
  lineTotalCents: number;
  isPurchasable: boolean;
  issue?: CartItemIssue | undefined;
  availableQuantity: number;
}

export interface CartSummary {
  id: string;
  status: "ACTIVE";
  items: FormattedCartItem[];
  itemCount: number;
  totalUnits: number;
  totalCents: number;
  currency: string;
  warnings: string[];
}

export function formatCartSummary(cartId: string, lines: CartItemDetailed[]): CartSummary {
  const items: FormattedCartItem[] = [];
  const warnings: string[] = [];
  let totalCents = 0;
  let totalUnits = 0;

  for (const line of lines) {
    const livePrice = line.product.priceCents;
    const lineTotal = line.item.quantity * livePrice;
    const availableStock = Math.max(0, line.inventory.quantityOnHand - line.inventory.quantityReserved);

    let isPurchasable = true;
    let issue: CartItemIssue | undefined;

    if (line.product.status !== "ACTIVE") {
      isPurchasable = false;
      issue = "PRODUCT_UNAVAILABLE";
      warnings.push(`Product '${line.product.name}' (${line.product.sku}) is no longer active and cannot be purchased.`);
    } else if (availableStock === 0) {
      isPurchasable = false;
      issue = "OUT_OF_STOCK";
      warnings.push(`Product '${line.product.name}' is currently out of stock.`);
    } else if (availableStock < line.item.quantity) {
      isPurchasable = false;
      issue = "PARTIALLY_AVAILABLE";
      warnings.push(
        `Only ${availableStock} unit(s) of '${line.product.name}' are available (requested ${line.item.quantity}).`,
      );
    }

    if (isPurchasable) {
      totalCents += lineTotal;
      totalUnits += line.item.quantity;
    }

    items.push({
      productId: line.item.productId,
      sku: line.product.sku,
      name: line.product.name,
      unitPriceCents: livePrice,
      currency: line.product.currency,
      quantity: line.item.quantity,
      lineTotalCents: lineTotal,
      isPurchasable,
      ...(issue ? { issue } : {}),
      availableQuantity: availableStock,
    });
  }

  return {
    id: cartId,
    status: "ACTIVE",
    items,
    itemCount: items.length,
    totalUnits,
    totalCents,
    currency: "USD",
    warnings,
  };
}

export class CartService {
  async getCartSummary(userId: string): Promise<CartSummary> {
    const cart = await cartRepository.getOrCreateActiveCart(db, userId);
    const lines = await cartRepository.findCartItemsWithDetails(db, cart.id);
    return formatCartSummary(cart.id, lines);
  }

  async addItem(userId: string, input: AddToCartInput): Promise<CartSummary> {
    // 1. Validate product exists and is active
    const product = await productRepository.findProductById(db, input.productId);
    if (!product || product.status !== "ACTIVE") {
      throw new AppError({
        statusCode: 404,
        code: ErrorCodes.PRODUCT_NOT_FOUND,
        message: `Product with ID '${input.productId}' was not found`,
      });
    }

    // 2. Validate current available stock
    const inv = await inventoryRepository.findInventoryByProductId(db, input.productId);
    const available = inv ? Math.max(0, inv.quantityOnHand - inv.quantityReserved) : 0;
    if (available < input.quantity) {
      throw new AppError({
        statusCode: 409,
        code: ErrorCodes.INSUFFICIENT_INVENTORY,
        message: `Requested ${input.quantity} units of SKU '${product.sku}', but only ${available} is available.`,
        details: { sku: product.sku, requested: input.quantity, available },
      });
    }

    // 3. Atomically upsert in transaction
    const cartId = await db.transaction(async (tx) => {
      const cart = await cartRepository.getOrCreateActiveCart(tx, userId);

      const existingItem = await cartRepository.findCartItem(tx, cart.id, input.productId);

      if (!existingItem) {
        // Enforce max distinct items limit
        const distinctCount = await cartRepository.countCartItems(tx, cart.id);
        if (distinctCount >= MAX_DISTINCT_CART_ITEMS) {
          throw new AppError({
            statusCode: 409,
            code: ErrorCodes.CART_LIMIT_EXCEEDED,
            message: `Cart cannot contain more than ${MAX_DISTINCT_CART_ITEMS} distinct items`,
            details: { maxAllowedItems: MAX_DISTINCT_CART_ITEMS },
          });
        }
      } else {
        // Combined quantity check against available stock
        const totalDesired = existingItem.quantity + input.quantity;
        if (totalDesired > available) {
          throw new AppError({
            statusCode: 409,
            code: ErrorCodes.INSUFFICIENT_INVENTORY,
            message: `Adding ${input.quantity} units exceeds available stock (${available}). Currently in cart: ${existingItem.quantity}.`,
            details: {
              sku: product.sku,
              currentInCart: existingItem.quantity,
              requestedAdd: input.quantity,
              available,
            },
          });
        }
      }

      // Upsert with atomic quantity cap check
      const updatedItem = await cartRepository.upsertCartItemWithCap(
        tx,
        cart.id,
        input.productId,
        input.quantity,
        env.CART_MAX_LINE_QUANTITY,
      );

      if (!updatedItem) {
        const currentQty = existingItem?.quantity ?? 0;
        throw new AppError({
          statusCode: 409,
          code: ErrorCodes.CART_ITEM_QUANTITY_EXCEEDED,
          message: `Cannot add ${input.quantity} units; line item quantity cannot exceed ${env.CART_MAX_LINE_QUANTITY}. Current: ${currentQty}`,
          details: {
            currentQuantity: currentQty,
            requestedAdd: input.quantity,
            maxAllowed: env.CART_MAX_LINE_QUANTITY,
            maxCanAdd: Math.max(0, env.CART_MAX_LINE_QUANTITY - currentQty),
          },
        });
      }

      return cart.id;
    });

    const lines = await cartRepository.findCartItemsWithDetails(db, cartId);
    return formatCartSummary(cartId, lines);
  }

  async updateItemQuantity(userId: string, productId: string, quantity: number): Promise<CartSummary> {
    const cart = await cartRepository.findActiveCartByUserId(db, userId);
    if (!cart) {
      throw new AppError({
        statusCode: 404,
        code: ErrorCodes.CART_ITEM_NOT_FOUND,
        message: "Cart item was not found",
      });
    }

    const existingItem = await cartRepository.findCartItem(db, cart.id, productId);
    if (!existingItem) {
      throw new AppError({
        statusCode: 404,
        code: ErrorCodes.CART_ITEM_NOT_FOUND,
        message: "Cart item was not found",
      });
    }

    const product = await productRepository.findProductById(db, productId);
    if (!product || product.status !== "ACTIVE") {
      throw new AppError({
        statusCode: 404,
        code: ErrorCodes.PRODUCT_NOT_FOUND,
        message: `Product with ID '${productId}' was not found or is no longer active`,
      });
    }

    const inv = await inventoryRepository.findInventoryByProductId(db, productId);
    const available = inv ? Math.max(0, inv.quantityOnHand - inv.quantityReserved) : 0;
    if (quantity > available) {
      throw new AppError({
        statusCode: 409,
        code: ErrorCodes.INSUFFICIENT_INVENTORY,
        message: `Requested ${quantity} units of SKU '${product.sku}', but only ${available} is available.`,
        details: { sku: product.sku, requested: quantity, available },
      });
    }

    await cartRepository.updateCartItemQuantity(db, cart.id, productId, quantity);

    const lines = await cartRepository.findCartItemsWithDetails(db, cart.id);
    return formatCartSummary(cart.id, lines);
  }

  async removeItem(userId: string, productId: string): Promise<CartSummary> {
    const cart = await cartRepository.getOrCreateActiveCart(db, userId);
    await cartRepository.deleteCartItem(db, cart.id, productId);
    const lines = await cartRepository.findCartItemsWithDetails(db, cart.id);
    return formatCartSummary(cart.id, lines);
  }

  async clearCart(userId: string): Promise<CartSummary> {
    const cart = await cartRepository.getOrCreateActiveCart(db, userId);
    await cartRepository.clearCart(db, cart.id);
    return formatCartSummary(cart.id, []);
  }
}

export const cartService = new CartService();
