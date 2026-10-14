import Fastify, { type FastifyInstance, type FastifyServerOptions } from "fastify";
import { registerErrorHandler, registerNotFoundHandler } from "./http/error-handler.js";
import { authPlugin } from "./http/plugins/auth.js";
import { authRoutes } from "./modules/auth/auth.routes.js";
import { cartRoutes } from "./modules/cart/cart.routes.js";
import { inventoryRoutes } from "./modules/inventory/inventory.routes.js";
import { orderRoutes } from "./modules/orders/order.routes.js";
import { productRoutes } from "./modules/products/product.routes.js";

export function buildApp(opts: FastifyServerOptions = {}): FastifyInstance {
  const app = Fastify({
    logger: false,
    ...opts,
  });

  registerErrorHandler(app);
  registerNotFoundHandler(app);
  app.register(authPlugin);
  app.register(authRoutes);
  app.register(productRoutes);
  app.register(inventoryRoutes);
  app.register(cartRoutes);
  app.register(orderRoutes);

  return app;
}
