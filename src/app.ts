import Fastify, { type FastifyInstance, type FastifyServerOptions } from "fastify";
import { env } from "./config/env.js";
import { registerErrorHandler, registerNotFoundHandler } from "./http/error-handler.js";
import { healthRoutes } from "./http/health.routes.js";
import { authPlugin } from "./http/plugins/auth.js";
import { securityPlugin } from "./http/plugins/security.js";
import { authRoutes } from "./modules/auth/auth.routes.js";
import { cartRoutes } from "./modules/cart/cart.routes.js";
import { inventoryRoutes } from "./modules/inventory/inventory.routes.js";
import { orderRoutes } from "./modules/orders/order.routes.js";
import { productRoutes } from "./modules/products/product.routes.js";

export interface AppOptions {
  /** Defaults to RATE_LIMIT_ENABLED, or on unless NODE_ENV=test. */
  rateLimit?: boolean;
  /** Defaults to CORS_ORIGINS. */
  corsOrigins?: string[];
}

export function buildApp(opts: FastifyServerOptions = {}, appOpts: AppOptions = {}): FastifyInstance {
  const app = Fastify({
    logger: false,
    ...opts,
  });

  registerErrorHandler(app);
  registerNotFoundHandler(app);

  // Connection draining: once close() starts, tell clients to drop keep-alive
  // sockets after their in-flight response. Otherwise a busy socket becomes an
  // idle keep-alive socket after close began and stalls shutdown until it times out.
  let closing = false;
  app.addHook("preClose", async () => {
    closing = true;
  });
  app.addHook("onSend", async (_request, reply) => {
    if (closing) reply.header("connection", "close");
  });

  // Must precede all routes: the rate limiter attaches to routes as they are declared.
  app.register(securityPlugin, {
    rateLimit: appOpts.rateLimit ?? env.RATE_LIMIT_ENABLED ?? env.NODE_ENV !== "test",
    corsOrigins: appOpts.corsOrigins ?? env.CORS_ORIGINS,
  });
  app.register(authPlugin);
  app.register(healthRoutes);
  app.register(authRoutes);
  app.register(productRoutes);
  app.register(inventoryRoutes);
  app.register(cartRoutes);
  app.register(orderRoutes);

  return app;
}
