import type { FastifyPluginAsync } from "fastify";
import { ProductIdParamSchema } from "../products/product.schemas.js";
import { inventoryService } from "./inventory.service.js";
import { AdjustInventorySchema, ListMovementsQuerySchema } from "./inventory.schemas.js";

export const inventoryRoutes: FastifyPluginAsync = async (app) => {
  app.post(
    "/admin/products/:id/inventory/adjustments",
    { preHandler: [app.requireRole("ADMIN")] },
    async (request, reply) => {
      const params = ProductIdParamSchema.parse(request.params);
      const body = AdjustInventorySchema.parse(request.body);
      const idempotencyKey = request.headers["idempotency-key"] as string | undefined;

      const result = await inventoryService.adjustInventory(request.user!, params.id, body, idempotencyKey);
      return reply.status(200).send(result);
    },
  );

  app.get(
    "/admin/products/:id/inventory/movements",
    { preHandler: [app.requireRole("ADMIN")] },
    async (request, reply) => {
      const params = ProductIdParamSchema.parse(request.params);
      const query = ListMovementsQuerySchema.parse(request.query);

      const result = await inventoryService.listMovements(params.id, {
        limit: query.limit,
        offset: query.offset,
      });
      return reply.status(200).send(result);
    },
  );
};
