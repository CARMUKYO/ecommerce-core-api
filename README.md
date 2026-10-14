# E-Commerce Core API

Portfolio-grade e-commerce backend API focused on domain modeling, relational integrity, ACID transactions, and integration testing against a real PostgreSQL database.

**Stack:** Node.js · TypeScript (strict) · Fastify · PostgreSQL · Drizzle ORM · Zod · Vitest

---

## Getting Started

```bash
cp .env.example .env
docker compose up -d          # PostgreSQL 17 on localhost:5433 (creates ecommerce_dev + ecommerce_test)
npm install
npm run db:migrate            # Apply migrations to development database
npm test                      # Migrates test database and runs all 98 integration tests
```

---

## Available Scripts

| Script | Purpose |
|---|---|
| `npm test` | Run all 98 integration and unit tests against real test DB |
| `npm run typecheck` | Strict TypeScript check (`tsc --noEmit`) |
| `npm run db:generate` | Generate reviewable SQL migrations from Drizzle schemas |
| `npm run db:migrate` | Apply migrations to `DATABASE_URL` |
| `npm run db:migrate:test` | Apply migrations to `TEST_DATABASE_URL` |
| `npm run build` | Compile TypeScript to `dist/` |

---

## Architectural Highlights

### 1. Separation of Concerns
- **Routes / Controllers:** HTTP transport, status code mappings, and Zod input validation only. Zero business logic.
- **Domain Services:** Pure business rules, invariant validations, and transactional orchestration.
- **Repositories:** Data access layer accepting `DbExecutor` (`db` or `tx`), managing queries and explicit locking.

### 2. Financial Precision
- All monetary values are strictly stored and computed as **integers in minor units** (`cents`). Floating-point money is completely prohibited.

### 3. Concurrency Protection & ACID Transactions
- **Race Condition Oversell Protection:** Parallel checkout requests are serialized through `SELECT ... FOR UPDATE` locks on inventory rows sorted in deterministic lexicographic order (eliminating deadlocks).
- **Database-Level Invariant (The Absolute Safety Net):** `CHECK (quantity_reserved <= quantity_on_hand)` prevents negative available stock even under application bypass.
- **Per-User Idempotency Keys:** Network retries for checkout or inventory adjustments replay committed results safely without double-charging or double-deducting stock.
- **Double-Restocking Defense:** Order cancellation uses atomic compare-and-set (`UPDATE ... WHERE status IN ('PENDING', 'PAID')`) coupled with stock restoration inside a single transaction.

---

## API Endpoints

### Products & Inventory (Admin)
- `POST /admin/products` — Create a product (`DRAFT`) with initial inventory
- `GET /admin/products` — List all products with full stock breakdown
- `GET /admin/products/:id` — View product details and stock
- `PATCH /admin/products/:id` — Edit product details (`name`, `description`, `priceCents`, `sku`)
- `POST /admin/products/:id/activate` — Transition `DRAFT` or `ARCHIVED` to `ACTIVE`
- `POST /admin/products/:id/archive` — Transition `DRAFT` or `ACTIVE` to `ARCHIVED`
- `POST /admin/products/:id/inventory/adjustments` — Modify `quantity_on_hand` by signed delta (requires `Idempotency-Key`)
- `GET /admin/products/:id/inventory/movements` — Inspect append-only audit ledger

### Catalog (Public)
- `GET /products` — List active products with available stock
- `GET /products/:id` — View active product details (returns 404 for draft/archived)

### Cart (Customer)
- `GET /cart` — View active cart summary with live pricing and availability warnings
- `POST /cart/items` — Add item or increment quantity (atomic upsert)
- `PATCH /cart/items/:productId` — Update item quantity (min 1, max 99)
- `DELETE /cart/items/:productId` — Remove line item
- `DELETE /cart` — Clear all items

### Checkout & Orders (Customer & Admin)
- `POST /checkout` — Convert active cart into immutable order (requires `Idempotency-Key`)
- `POST /orders/:id/cancel` — Cancel order and safely restore reserved stock
- `GET /orders/:id` — View order with historical item snapshots
- `GET /orders` — List user's historical orders

---

## Consistent Error Envelope (RFC 7807 Pattern)

All API responses never leak internal driver or database errors:
```json
{
  "error": {
    "code": "INSUFFICIENT_INVENTORY",
    "message": "Requested 3 units of SKU-101, but only 1 is available.",
    "details": {
      "sku": "SKU-101",
      "requested": 3,
      "available": 1
    }
  }
}
```
