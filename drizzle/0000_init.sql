CREATE TYPE "public"."cart_status" AS ENUM('ACTIVE', 'CONVERTED', 'ABANDONED');--> statement-breakpoint
CREATE TYPE "public"."inventory_movement_reason" AS ENUM('INITIAL_STOCK', 'ADMIN_ADJUSTMENT', 'ORDER_RESERVED', 'ORDER_RELEASED', 'ORDER_SHIPPED');--> statement-breakpoint
CREATE TYPE "public"."order_status" AS ENUM('PENDING', 'PAID', 'SHIPPED', 'CANCELLED');--> statement-breakpoint
CREATE TYPE "public"."product_status" AS ENUM('DRAFT', 'ACTIVE', 'ARCHIVED');--> statement-breakpoint
CREATE TYPE "public"."user_role" AS ENUM('CUSTOMER', 'ADMIN');--> statement-breakpoint
CREATE TYPE "public"."user_status" AS ENUM('ACTIVE', 'SUSPENDED');--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"password_hash" text NOT NULL,
	"role" "user_role" DEFAULT 'CUSTOMER' NOT NULL,
	"status" "user_status" DEFAULT 'ACTIVE' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_key" UNIQUE("email"),
	CONSTRAINT "users_email_lowercase_chk" CHECK ("users"."email" = lower("users"."email")),
	CONSTRAINT "users_email_format_chk" CHECK ("users"."email" ~ '^[^@\s]+@[^@\s]+$')
);
--> statement-breakpoint
CREATE TABLE "products" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sku" text NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"price_cents" integer NOT NULL,
	"currency" char(3) DEFAULT 'USD' NOT NULL,
	"status" "product_status" DEFAULT 'DRAFT' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "products_sku_key" UNIQUE("sku"),
	CONSTRAINT "products_sku_format_chk" CHECK ("products"."sku" = upper("products"."sku") AND length("products"."sku") BETWEEN 1 AND 64),
	CONSTRAINT "products_name_not_blank_chk" CHECK (length(btrim("products"."name")) > 0),
	CONSTRAINT "products_price_non_negative_chk" CHECK ("products"."price_cents" >= 0),
	CONSTRAINT "products_currency_iso_chk" CHECK ("products"."currency" ~ '^[A-Z]{3}$')
);
--> statement-breakpoint
CREATE TABLE "inventory" (
	"product_id" uuid PRIMARY KEY NOT NULL,
	"quantity_on_hand" integer DEFAULT 0 NOT NULL,
	"quantity_reserved" integer DEFAULT 0 NOT NULL,
	"version" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "inventory_on_hand_non_negative_chk" CHECK ("inventory"."quantity_on_hand" >= 0),
	CONSTRAINT "inventory_reserved_non_negative_chk" CHECK ("inventory"."quantity_reserved" >= 0),
	CONSTRAINT "inventory_reserved_lte_on_hand_chk" CHECK ("inventory"."quantity_reserved" <= "inventory"."quantity_on_hand")
);
--> statement-breakpoint
CREATE TABLE "inventory_movements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"product_id" uuid NOT NULL,
	"delta_on_hand" integer DEFAULT 0 NOT NULL,
	"delta_reserved" integer DEFAULT 0 NOT NULL,
	"reason" "inventory_movement_reason" NOT NULL,
	"order_id" uuid,
	"actor_user_id" uuid,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "inventory_movements_non_zero_chk" CHECK ("inventory_movements"."delta_on_hand" <> 0 OR "inventory_movements"."delta_reserved" <> 0),
	CONSTRAINT "inventory_movements_order_ref_chk" CHECK ("inventory_movements"."reason" NOT IN ('ORDER_RESERVED', 'ORDER_RELEASED', 'ORDER_SHIPPED') OR "inventory_movements"."order_id" IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "cart_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"cart_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"quantity" integer NOT NULL,
	"added_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cart_items_quantity_bounds_chk" CHECK ("cart_items"."quantity" >= 1 AND "cart_items"."quantity" <= 999)
);
--> statement-breakpoint
CREATE TABLE "carts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"status" "cart_status" DEFAULT 'ACTIVE' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "order_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"quantity" integer NOT NULL,
	"unit_price_cents_snapshot" integer NOT NULL,
	"product_name_snapshot" text NOT NULL,
	"sku_snapshot" text NOT NULL,
	"line_total_cents" bigint NOT NULL,
	CONSTRAINT "order_items_quantity_positive_chk" CHECK ("order_items"."quantity" >= 1),
	CONSTRAINT "order_items_unit_price_non_negative_chk" CHECK ("order_items"."unit_price_cents_snapshot" >= 0),
	CONSTRAINT "order_items_line_total_chk" CHECK ("order_items"."line_total_cents" = "order_items"."quantity"::bigint * "order_items"."unit_price_cents_snapshot")
);
--> statement-breakpoint
CREATE TABLE "orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"cart_id" uuid NOT NULL,
	"idempotency_key" text NOT NULL,
	"request_fingerprint" text NOT NULL,
	"status" "order_status" DEFAULT 'PENDING' NOT NULL,
	"total_cents" bigint NOT NULL,
	"currency" char(3) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"paid_at" timestamp with time zone,
	"shipped_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	CONSTRAINT "orders_cart_id_key" UNIQUE("cart_id"),
	CONSTRAINT "orders_idempotency_key_length_chk" CHECK (length("orders"."idempotency_key") BETWEEN 1 AND 255),
	CONSTRAINT "orders_total_non_negative_chk" CHECK ("orders"."total_cents" >= 0),
	CONSTRAINT "orders_currency_iso_chk" CHECK ("orders"."currency" ~ '^[A-Z]{3}$'),
	CONSTRAINT "orders_cancelled_at_consistency_chk" CHECK (("orders"."status" = 'CANCELLED') = ("orders"."cancelled_at" IS NOT NULL)),
	CONSTRAINT "orders_shipped_at_consistency_chk" CHECK (("orders"."status" = 'SHIPPED') = ("orders"."shipped_at" IS NOT NULL)),
	CONSTRAINT "orders_paid_at_consistency_chk" CHECK (("orders"."status" NOT IN ('PAID', 'SHIPPED') OR "orders"."paid_at" IS NOT NULL) AND ("orders"."status" <> 'PENDING' OR "orders"."paid_at" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "inventory" ADD CONSTRAINT "inventory_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cart_items" ADD CONSTRAINT "cart_items_cart_id_carts_id_fk" FOREIGN KEY ("cart_id") REFERENCES "public"."carts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cart_items" ADD CONSTRAINT "cart_items_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "carts" ADD CONSTRAINT "carts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_cart_id_carts_id_fk" FOREIGN KEY ("cart_id") REFERENCES "public"."carts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "products_status_idx" ON "products" USING btree ("status");--> statement-breakpoint
CREATE INDEX "inventory_movements_product_created_at_idx" ON "inventory_movements" USING btree ("product_id","created_at");--> statement-breakpoint
CREATE INDEX "inventory_movements_order_id_idx" ON "inventory_movements" USING btree ("order_id");--> statement-breakpoint
CREATE UNIQUE INDEX "cart_items_cart_product_uidx" ON "cart_items" USING btree ("cart_id","product_id");--> statement-breakpoint
CREATE INDEX "cart_items_product_id_idx" ON "cart_items" USING btree ("product_id");--> statement-breakpoint
CREATE UNIQUE INDEX "carts_one_active_per_user_uidx" ON "carts" USING btree ("user_id") WHERE "carts"."status" = 'ACTIVE';--> statement-breakpoint
CREATE INDEX "carts_user_id_idx" ON "carts" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "carts_status_updated_at_idx" ON "carts" USING btree ("status","updated_at");--> statement-breakpoint
CREATE UNIQUE INDEX "order_items_order_product_uidx" ON "order_items" USING btree ("order_id","product_id");--> statement-breakpoint
CREATE INDEX "order_items_product_id_idx" ON "order_items" USING btree ("product_id");--> statement-breakpoint
CREATE UNIQUE INDEX "orders_user_idempotency_key_uidx" ON "orders" USING btree ("user_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "orders_user_created_at_idx" ON "orders" USING btree ("user_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "orders_status_created_at_idx" ON "orders" USING btree ("status","created_at");