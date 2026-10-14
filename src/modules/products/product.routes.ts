import type { FastifyPluginAsync } from "fastify";
import { productService } from "./product.service.js";
import {
  CreateProductSchema,
  ListProductsQuerySchema,
  ProductIdParamSchema,
  UpdateProductSchema,
} from "./product.schemas.js";

export const productRoutes: FastifyPluginAsync = async (app) => {
  // Public catalog routes
  app.get("/products", async (request, reply) => {
    const query = ListProductsQuerySchema.parse(request.query);
    const result = await productService.listProducts({
      mustBeActive: true,
      limit: query.limit,
      offset: query.offset,
    });
    return reply.status(200).send(result);
  });

  app.get("/products/:id", async (request, reply) => {
    const params = ProductIdParamSchema.parse(request.params);
    const product = await productService.getProductById(params.id, { mustBeActive: true });
    return reply.status(200).send({ product });
  });

  // Admin routes
  app.post("/admin/products", { preHandler: [app.requireRole("ADMIN")] }, async (request, reply) => {
    const body = CreateProductSchema.parse(request.body);
    const product = await productService.createProduct(request.user!, body);
    return reply.status(201).send({ product });
  });

  app.get("/admin/products", { preHandler: [app.requireRole("ADMIN")] }, async (request, reply) => {
    const query = ListProductsQuerySchema.parse(request.query);
    const result = await productService.listProducts({
      mustBeActive: false,
      status: query.status,
      limit: query.limit,
      offset: query.offset,
    });
    return reply.status(200).send(result);
  });

  app.get("/admin/products/:id", { preHandler: [app.requireRole("ADMIN")] }, async (request, reply) => {
    const params = ProductIdParamSchema.parse(request.params);
    const product = await productService.getProductById(params.id, { mustBeActive: false });
    return reply.status(200).send({ product });
  });

  app.patch("/admin/products/:id", { preHandler: [app.requireRole("ADMIN")] }, async (request, reply) => {
    const params = ProductIdParamSchema.parse(request.params);
    const body = UpdateProductSchema.parse(request.body);
    const product = await productService.updateProduct(request.user!, params.id, body);
    return reply.status(200).send({ product });
  });

  app.post("/admin/products/:id/activate", { preHandler: [app.requireRole("ADMIN")] }, async (request, reply) => {
    const params = ProductIdParamSchema.parse(request.params);
    const product = await productService.activateProduct(request.user!, params.id);
    return reply.status(200).send({ product });
  });

  app.post("/admin/products/:id/archive", { preHandler: [app.requireRole("ADMIN")] }, async (request, reply) => {
    const params = ProductIdParamSchema.parse(request.params);
    const product = await productService.archiveProduct(request.user!, params.id);
    return reply.status(200).send({ product });
  });
};
