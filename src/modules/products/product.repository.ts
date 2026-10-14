import { and, desc, eq, inArray, type SQL } from "drizzle-orm";
import type { DbExecutor } from "../../db/client.js";
import { inventory, type Inventory } from "../../db/schema/inventory.js";
import { products, type NewProduct, type Product } from "../../db/schema/products.js";
import type { ProductStatus } from "./product-status.js";

export interface ProductWithInventory {
  product: Product;
  inventory: Inventory;
}

export class ProductRepository {
  async createProduct(executor: DbExecutor, data: NewProduct): Promise<Product> {
    const [row] = await executor.insert(products).values(data).returning();
    return row!;
  }

  async findProductById(executor: DbExecutor, id: string): Promise<Product | undefined> {
    const [row] = await executor.select().from(products).where(eq(products.id, id));
    return row;
  }

  async findProductByIdWithInventory(executor: DbExecutor, id: string): Promise<ProductWithInventory | undefined> {
    const rows = await executor
      .select({
        product: products,
        inventory: inventory,
      })
      .from(products)
      .innerJoin(inventory, eq(products.id, inventory.productId))
      .where(eq(products.id, id));

    const row = rows[0];
    return row ? { product: row.product, inventory: row.inventory } : undefined;
  }

  async listProductsWithInventory(
    executor: DbExecutor,
    opts: { status?: ProductStatus | undefined; limit: number; offset: number },
  ): Promise<{ items: ProductWithInventory[]; total: number }> {
    const conditions: SQL[] = [];
    if (opts.status) {
      conditions.push(eq(products.status, opts.status));
    }

    const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

    const rows = await executor
      .select({
        product: products,
        inventory: inventory,
      })
      .from(products)
      .innerJoin(inventory, eq(products.id, inventory.productId))
      .where(whereClause)
      .orderBy(desc(products.createdAt), products.id)
      .limit(opts.limit)
      .offset(opts.offset);

    // Simple count query for pagination
    const countRows = await executor
      .select({ id: products.id })
      .from(products)
      .where(whereClause);

    return {
      items: rows.map((r) => ({ product: r.product, inventory: r.inventory })),
      total: countRows.length,
    };
  }

  async updateProduct(executor: DbExecutor, id: string, data: Partial<NewProduct>): Promise<Product | undefined> {
    const [row] = await executor.update(products).set(data).where(eq(products.id, id)).returning();
    return row;
  }

  async compareAndSetStatus(
    executor: DbExecutor,
    id: string,
    allowedFrom: readonly ProductStatus[],
    to: ProductStatus,
  ): Promise<Product | undefined> {
    const [row] = await executor
      .update(products)
      .set({ status: to })
      .where(and(eq(products.id, id), inArray(products.status, allowedFrom as ProductStatus[])))
      .returning();
    return row;
  }
}

export const productRepository = new ProductRepository();
