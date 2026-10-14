import type { FastifyPluginAsync } from "fastify";
import {
  AddToCartSchema,
  CartItemParamSchema,
  UpdateCartItemSchema,
} from "./cart.schemas.js";
import { cartService } from "./cart.service.js";

export const cartRoutes: FastifyPluginAsync = async (app) => {
  // All cart endpoints require an authenticated user
  // onRequest runs before body parsing: unauthenticated requests are rejected
  // with 401 before we spend any work on (or reveal anything about) the body.
  app.addHook("onRequest", app.authenticate);

  app.get("/cart", async (request, reply) => {
    const summary = await cartService.getCartSummary(request.user!.id);
    return reply.status(200).send(summary);
  });

  app.post("/cart/items", async (request, reply) => {
    const body = AddToCartSchema.parse(request.body);
    const summary = await cartService.addItem(request.user!.id, body);
    return reply.status(200).send(summary);
  });

  app.patch("/cart/items/:productId", async (request, reply) => {
    const params = CartItemParamSchema.parse(request.params);
    const body = UpdateCartItemSchema.parse(request.body);
    const summary = await cartService.updateItemQuantity(request.user!.id, params.productId, body.quantity);
    return reply.status(200).send(summary);
  });

  app.delete("/cart/items/:productId", async (request, reply) => {
    const params = CartItemParamSchema.parse(request.params);
    const summary = await cartService.removeItem(request.user!.id, params.productId);
    return reply.status(200).send(summary);
  });

  app.delete("/cart", async (request, reply) => {
    const summary = await cartService.clearCart(request.user!.id);
    return reply.status(200).send(summary);
  });
};
