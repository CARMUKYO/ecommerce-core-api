import type { FastifyPluginAsync } from "fastify";
import { ListOrdersQuerySchema, OrderIdParamSchema } from "./order.schemas.js";
import { orderService } from "./order.service.js";

export const orderRoutes: FastifyPluginAsync = async (app) => {
  app.addHook("preHandler", app.authenticate);

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
};
