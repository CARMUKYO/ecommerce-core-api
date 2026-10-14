import Fastify, { type FastifyInstance, type FastifyServerOptions } from "fastify";
import { registerErrorHandler } from "./http/error-handler.js";
import { authPlugin } from "./http/plugins/auth.js";
import { inventoryRoutes } from "./modules/inventory/inventory.routes.js";
import { productRoutes } from "./modules/products/product.routes.js";

export function buildApp(opts: FastifyServerOptions = {}): FastifyInstance {
  const app = Fastify({
    logger: false,
    ...opts,
  });

  registerErrorHandler(app);
  app.register(authPlugin);
  app.register(productRoutes);
  app.register(inventoryRoutes);

  return app;
}
