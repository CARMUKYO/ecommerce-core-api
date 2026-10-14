import { desc, eq, sql } from "drizzle-orm";
import type { DbExecutor } from "../../db/client.js";
import {
  inventory,
  inventoryMovements,
  type Inventory,
  type InventoryMovement,
  type NewInventory,
  type NewInventoryMovement,
} from "../../db/schema/inventory.js";

export class InventoryRepository {
  async createInventory(executor: DbExecutor, data: NewInventory): Promise<Inventory> {
    const [row] = await executor.insert(inventory).values(data).returning();
    return row!;
  }

  async findInventoryByProductId(executor: DbExecutor, productId: string): Promise<Inventory | undefined> {
    const [row] = await executor.select().from(inventory).where(eq(inventory.productId, productId));
    return row;
  }

  /**
   * Acquire a row lock on inventory for this product.
   * Serializes concurrent modifications (checkout vs admin adjustment).
   */
  async getInventoryForUpdate(executor: DbExecutor, productId: string): Promise<Inventory | undefined> {
    const result = await executor.execute(
      sql`SELECT product_id, quantity_on_hand, quantity_reserved, version, updated_at
          FROM inventory
          WHERE product_id = ${productId}
          FOR UPDATE`,
    );
    const row = result.rows[0];
    if (!row) return undefined;
    return {
      productId: row.product_id as string,
      quantityOnHand: Number(row.quantity_on_hand),
      quantityReserved: Number(row.quantity_reserved),
      version: Number(row.version),
      updatedAt: new Date(row.updated_at as string | number),
    };
  }

  async updateInventoryOnHand(
    executor: DbExecutor,
    productId: string,
    newOnHand: number,
  ): Promise<Inventory | undefined> {
    const [row] = await executor
      .update(inventory)
      .set({
        quantityOnHand: newOnHand,
        version: sql`${inventory.version} + 1`,
      })
      .where(eq(inventory.productId, productId))
      .returning();
    return row;
  }

  async insertMovement(executor: DbExecutor, data: NewInventoryMovement): Promise<InventoryMovement> {
    const [row] = await executor.insert(inventoryMovements).values(data).returning();
    return row!;
  }

  async findMovementByIdempotencyKey(
    executor: DbExecutor,
    productId: string,
    idempotencyKey: string,
  ): Promise<InventoryMovement | undefined> {
    const [row] = await executor
      .select()
      .from(inventoryMovements)
      .where(
        sql`${inventoryMovements.productId} = ${productId} AND ${inventoryMovements.idempotencyKey} = ${idempotencyKey}`,
      );
    return row;
  }

  async listMovements(
    executor: DbExecutor,
    productId: string,
    opts: { limit: number; offset: number },
  ): Promise<{ items: InventoryMovement[]; total: number }> {
    const rows = await executor
      .select()
      .from(inventoryMovements)
      .where(eq(inventoryMovements.productId, productId))
      .orderBy(desc(inventoryMovements.createdAt))
      .limit(opts.limit)
      .offset(opts.offset);

    const countRows = await executor
      .select({ id: inventoryMovements.id })
      .from(inventoryMovements)
      .where(eq(inventoryMovements.productId, productId));

    return {
      items: rows,
      total: countRows.length,
    };
  }
}

export const inventoryRepository = new InventoryRepository();
