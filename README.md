# E-Commerce Core API

Portfolio-grade e-commerce backend focused on domain modeling, relational integrity, ACID transactions, and integration testing against a real PostgreSQL database.

**Stack:** Node.js · TypeScript (strict) · Fastify · PostgreSQL · Drizzle ORM · Zod · Vitest

## Getting started

```bash
cp .env.example .env
docker compose up -d          # Postgres 17 on localhost:5433 (creates ecommerce_dev + ecommerce_test)
npm install
npm run db:migrate            # apply migrations to the dev database
npm test                      # migrates the test database, then runs integration tests
```

## Scripts

| Script | Purpose |
|---|---|
| `npm run db:generate` | Generate a SQL migration from schema changes (`./drizzle`) |
| `npm run db:migrate` | Apply migrations to `DATABASE_URL` |
| `npm run db:migrate:test` | Apply migrations to `TEST_DATABASE_URL` |
| `npm test` | Run integration tests (serially, against the real test DB) |
| `npm run typecheck` | Strict TypeScript check |

## Layout

```
src/
  config/env.ts        Zod-validated environment
  db/
    schema/            Drizzle table definitions (source of truth for constraints)
    client.ts          Pool + Drizzle client, Tx types
    migrate.ts         Migration runner
drizzle/               Generated, reviewable SQL migrations
tests/
  schema/              Proves DB-level invariants (CHECK / UNIQUE / FK / concurrency)
  helpers/             Fixtures and PostgreSQL error assertions
```

## Key invariants enforced by PostgreSQL

- `inventory.quantity_reserved <= quantity_on_hand`, so available stock can never go negative
- One `ACTIVE` cart per user (partial unique index)
- One line per product per cart (`UNIQUE (cart_id, product_id)`)
- `UNIQUE (user_id, idempotency_key)` and `UNIQUE (cart_id)` on orders
- Products, orders and users with history cannot be hard-deleted (`ON DELETE RESTRICT`)
- Order line `line_total_cents = quantity × unit_price_cents_snapshot`
- Order status and lifecycle timestamps (`paid_at`, `shipped_at`, `cancelled_at`) must agree
