ALTER TABLE "inventory_movements" ADD COLUMN "idempotency_key" text;--> statement-breakpoint
ALTER TABLE "inventory_movements" ADD COLUMN "request_fingerprint" text;--> statement-breakpoint
CREATE UNIQUE INDEX "inventory_movements_product_idempotency_uidx" ON "inventory_movements" USING btree ("product_id","idempotency_key") WHERE "inventory_movements"."idempotency_key" IS NOT NULL;