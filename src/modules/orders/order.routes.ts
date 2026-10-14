import type { FastifyPluginAsync } from "fastify";
import { AdminListOrdersQuerySchema, ListOrdersQuerySchema, OrderIdParamSchema } from "./order.schemas.js";
import { orderService } from "./order.service.js";

export const orderRoutes: FastifyPluginAsync = async (app) => {
  // onRequest runs before body parsing: unauthenticated requests are rejected
  // with 401 before we spend any work on (or reveal anything about) the body.
  app.addHook("onRequest", app.authenticate);

  app.post("/checkout", async (request, reply) => {
    const idempotencyKey = request.headers["idempotency-key"] as string | undefined;
    const result = await orderService.checkout(request.user!, idempotencyKey);
    const statusCode = result.replayed ? 200 : 201;
    return reply.status(statusCode).send(result);
  });

  app.post("/orders/:id/cancel", async (request, reply) => {
    const params = OrderIdParamSchema.parse(request.params);
    const result = await orderService.cancelOrder(request.user!, params.id);
    return reply.status(200).send(result);
  });

  app.get("/orders/:id", async (request, reply) => {
    const params = OrderIdParamSchema.parse(request.params);
    const order = await orderService.getOrderById(request.user!, params.id);
    return reply.status(200).send({ order });
  });

  app.get("/orders", async (request, reply) => {
    const query = ListOrdersQuerySchema.parse(request.query);
    const result = await orderService.listOrders(request.user!, query);
    return reply.status(200).send(result);
  });

  // Admin fulfillment (#9). The plugin-level hook has already authenticated.
  app.get("/admin/orders", { onRequest: [app.requireRole("ADMIN")] }, async (request, reply) => {
    const query = AdminListOrdersQuerySchema.parse(request.query);
    const result = await orderService.listAllOrders(query);
    return reply.status(200).send(result);
  });

  app.post("/admin/orders/:id/mark-paid", { onRequest: [app.requireRole("ADMIN")] }, async (request, reply) => {
    const params = OrderIdParamSchema.parse(request.params);
    const result = await orderService.markPaid(request.user!, params.id);
    return reply.status(200).send(result);
  });

  app.post("/admin/orders/:id/ship", { onRequest: [app.requireRole("ADMIN")] }, async (request, reply) => {
    const params = OrderIdParamSchema.parse(request.params);
    const result = await orderService.shipOrder(request.user!, params.id);
    return reply.status(200).send(result);
  });
};
