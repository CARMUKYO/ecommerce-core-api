# E-Commerce Core API

E-commerce backend API focused on domain modeling, relational integrity, ACID transactions, and integration testing against a real PostgreSQL database.

**Stack:** Node.js · TypeScript (strict) · Fastify · PostgreSQL · Drizzle ORM · Zod · Vitest

---

## Getting Started

```bash
cp .env.example .env
docker compose up -d          # PostgreSQL 17 on localhost:5433 (creates ecommerce_dev + ecommerce_test)
npm install
npm run db:migrate            # Apply migrations to development database
ADMIN_EMAIL=you@example.com ADMIN_PASSWORD='a-long-passphrase' npm run seed:admin
npm test                      # Migrates test database and runs all 178 tests
```

---

## Available Scripts

| Script | Purpose |
|---|---|
| `npm test` | Run all 178 integration and unit tests against real test DB |
| `npm run typecheck` | Strict TypeScript check (`tsc --noEmit`) |
| `npm run db:generate` | Generate reviewable SQL migrations from Drizzle schemas |
| `npm run db:migrate` | Apply migrations to `DATABASE_URL` |
| `npm run db:migrate:test` | Apply migrations to `TEST_DATABASE_URL` |
| `npm run seed:admin` | Create an `ADMIN` from `ADMIN_EMAIL` / `ADMIN_PASSWORD` env vars (admins cannot self-register) |
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
- **Cart Locking:** Checkout and every cart write lock the cart row first (lock order: cart → inventory), so an order always matches the cart exactly and no write can land in a converted cart.

### 4. Authentication
- **Opaque session tokens:** 256-bit random bearer tokens; only their SHA-256 hash is stored, so a database leak yields no usable credentials. Absolute expiry (`SESSION_TTL_HOURS`, default 7 days); logout revokes the current session.
- **Password storage:** salted `scrypt` (N=2^17, r=8, p=1) via Node's built-in crypto, with parameters encoded per hash for future upgrades.
- **No account enumeration:** unknown email and wrong password return byte-identical `401 INVALID_CREDENTIALS` responses with matched timing.
- **No privilege escalation:** registration always creates a `CUSTOMER`; admins are created only by `npm run seed:admin`. Suspension takes effect on the next request.

### 5. Order Lifecycle
- **Single state machine** (`order-status.ts`): `PENDING → PAID | CANCELLED`, `PAID → SHIPPED | CANCELLED`; `SHIPPED` and `CANCELLED` are terminal.
- **Stock semantics:** checkout reserves (`reserved += q`); shipping consumes (`on_hand -= q`, `reserved -= q`); cancellation releases (`reserved -= q`). Every change writes an `inventory_movements` row, so the ledger always sums to current stock.
- **Cancellation policy:** customers may cancel `PENDING` orders; cancelling a `PAID` order (refund required) is admin-only.
- **Unpaid order expiry:** `PENDING` orders older than `PENDING_ORDER_TTL_MINUTES` (default 30) are auto-cancelled and their stock released, so unpaid orders cannot hoard inventory.

### 6. Production Hardening
- **Rate limiting:** 100 req/min per IP globally; `/auth/register` 5/min per IP; `/auth/login` 20/min per IP plus 5/min per IP+email. `429 RATE_LIMITED` with `Retry-After`. Set `TRUST_PROXY=true` only behind a reverse proxy.
- **Security headers** (helmet) and **CORS denied by default** (allowlist via `CORS_ORIGINS`).
- **Database guards:** `statement_timeout`, `lock_timeout`, `idle_in_transaction_session_timeout`; timeouts surface as retryable `503 SERVICE_BUSY`.
- **Graceful shutdown:** on SIGTERM/SIGINT, stops jobs, drains in-flight requests (keep-alive sockets get `Connection: close`), closes the pool; force-exits after 10s.
- **Background jobs:** in-process scheduler (expire unpaid orders every minute, purge expired sessions every 15 min), guarded by Postgres advisory locks so multiple instances never run the same job concurrently. Disable with `JOBS_ENABLED=false`.
- **Lock order** everywhere: cart → products (shared) → inventory, and order → inventory, so concurrent operations cannot deadlock.

---

## API Endpoints

Authenticated endpoints expect `Authorization: Bearer <token>` from `POST /auth/login`.

### Auth
- `POST /auth/register` — Create a customer account (`email`, `password` of 12–128 chars)
- `POST /auth/login` — Exchange credentials for a session token (`token`, `expiresAt`, `user`)
- `POST /auth/logout` — Revoke the current session (204)
- `GET /auth/me` — Current user profile

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
- `GET /products` — List active products with availability (`availableQuantity`, `inStock` only)
- `GET /products/:id` — View active product details (returns 404 for draft/archived)

### Cart (Customer)
- `GET /cart` — View active cart summary with live pricing and availability warnings
- `POST /cart/items` — Add item or increment quantity (atomic upsert)
- `PATCH /cart/items/:productId` — Update item quantity (min 1, max 99)
- `DELETE /cart/items/:productId` — Remove line item
- `DELETE /cart` — Clear all items

### Health
- `GET /health` — Liveness
- `GET /ready` — Readiness (database reachable); `503` otherwise

### Checkout & Orders (Customer & Admin)
- `POST /checkout` — Convert active cart into immutable order (requires `Idempotency-Key`)
- `POST /orders/:id/cancel` — Cancel order and release reserved stock (customers: `PENDING` only; admins: `PENDING` or `PAID`)
- `GET /orders/:id` — View order with historical item snapshots
- `GET /orders` — List user's historical orders

### Order Fulfillment (Admin)
- `GET /admin/orders?status=&userId=` — List orders across all users
- `POST /admin/orders/:id/mark-paid` — `PENDING → PAID`
- `POST /admin/orders/:id/ship` — `PAID → SHIPPED` (consumes reserved stock)

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
