import { and, count, desc, eq, sql, type SQL } from "drizzle-orm";
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

    const [countRow] = await executor.select({ total: count() }).from(products).where(whereClause);

    return {
      items: rows.map((r) => ({ product: r.product, inventory: r.inventory })),
      total: countRow?.total ?? 0,
    };
  }

  /** Exclusive row lock for read-check-write edits (serializes with status changes). */
  async lockProductForUpdate(executor: DbExecutor, id: string): Promise<Product | undefined> {
    const [row] = await executor.select().from(products).where(eq(products.id, id)).for("update");
    return row;
  }

  /**
   * Shared locks on the products being purchased: concurrent checkouts don't
   * block each other, but an archive or price edit waits until checkout commits.
   * Lock order: cart -> products -> inventory. Ids must be sorted.
   */
  async lockProductsForShare(executor: DbExecutor, sortedIds: string[]): Promise<void> {
    if (sortedIds.length === 0) return;
    await executor.execute(
      sql`SELECT id FROM products WHERE id IN (${sql.join(sortedIds.map((id) => sql`${id}`), sql`, `)})
          ORDER BY id FOR SHARE`,
    );
  }

  async updateProduct(executor: DbExecutor, id: string, data: Partial<NewProduct>): Promise<Product | undefined> {
    const [row] = await executor.update(products).set(data).where(eq(products.id, id)).returning();
    return row;
  }

}

export const productRepository = new ProductRepository();
