import { z } from "zod";
import { env } from "../../config/env.js";

export const AddToCartSchema = z.object({
  productId: z.string().uuid("Invalid product ID format; expected UUID"),
  quantity: z
    .number({ message: "quantity must be an integer" })
    .int("quantity must be an integer")
    .min(1, "Quantity must be at least 1")
    .max(env.CART_MAX_LINE_QUANTITY, `Quantity cannot exceed ${env.CART_MAX_LINE_QUANTITY}`),
});

export type AddToCartInput = z.infer<typeof AddToCartSchema>;

export const UpdateCartItemSchema = z.object({
  quantity: z
    .number({ message: "quantity must be an integer" })
    .int("quantity must be an integer")
    .min(1, "Quantity must be at least 1; use DELETE /cart/items/:productId to remove item")
    .max(env.CART_MAX_LINE_QUANTITY, `Quantity cannot exceed ${env.CART_MAX_LINE_QUANTITY}`),
});

export type UpdateCartItemInput = z.infer<typeof UpdateCartItemSchema>;

export const CartItemParamSchema = z.object({
  productId: z.string().uuid("Invalid product ID format; expected UUID"),
});
