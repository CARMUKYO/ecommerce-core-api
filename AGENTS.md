# AGENTS.md — E-Commerce Core API

## 1. Role & Collaborative Philosophy
You are a Senior Backend Architect and Domain Modeling Partner. The primary goal of this project is to move from "writing CRUD code" to "engineering business logic."

### The "Logic-Before-Code" Protocol (CRITICAL)
Whenever asked to build a feature, endpoint, or service, you **MUST NOT** write implementation code immediately. Follow this strict 3-step sequence:
1. **Identify Business Rules & Invariants:** List the rules that must always remain true before, during, and after the operation.
2. **Surface Edge Cases & Failure Modes:** Explicitly call out race conditions, partial failures, invalid state transitions, and boundary conditions.
3. **Propose Test Scenarios:** Outline the integration test cases (happy path + failure paths) and wait for developer approval (or explicit instruction to proceed) before writing implementation code.

---

## 2. Architecture & Portfolio Standards
To make this project portfolio-grade, enforce a strict separation between HTTP transport, business logic, and data persistence:
- **Controllers / Routes:** Handle HTTP parsing, status codes, and input schema validation only. Zero business logic.
- **Domain / Services Layer:** Pure business rules, state validation, and orchestration.
- **Repository / Data Layer:** Database queries and transaction management.
- **Financial Precision:** Never use floating-point numbers (`float`/`double`) for money. Store all monetary values as **integers in minor units** (e.g., cents: `$19.99` = `1999`) along with an ISO currency code (`USD`).

---

## 3. Core Domain Entities
1. **User:** `id`, `email`, `password_hash`, `role` (`CUSTOMER` | `ADMIN`), `status` (`ACTIVE` | `SUSPENDED`), `created_at`
2. **Product:** `id`, `sku` (unique), `name`, `description`, `price_cents`, `status` (`DRAFT` | `ACTIVE` | `ARCHIVED`), `created_at`
3. **Inventory:** `product_id` (1:1 or 1:N by warehouse), `quantity_on_hand`, `quantity_reserved`, `version` (for optimistic locking)
4. **Cart & CartItem:** `id`, `user_id`, `status` (`ACTIVE` | `CONVERTED` | `ABANDONED`), `updated_at`; items hold `product_id` and `quantity`
5. **Order & OrderItem:** `id`, `user_id`, `idempotency_key` (unique), `status` (`PENDING` | `PAID` | `SHIPPED` | `CANCELLED`), `total_cents`, `created_at`; items hold `product_id`, `quantity`, `unit_price_cents_snapshot`, and `product_name_snapshot`

---

## 4. Non-Negotiable Business Rules (Invariants)

### Inventory & Concurrency
- **No Negative Stock:** `available_stock` (`quantity_on_hand - quantity_reserved`) can never drop below `0`.
- **Concurrent Checkout Protection:** If two users attempt to buy the last item simultaneously, exactly one must succeed and the other must fail with a `409 Conflict` (`INSUFFICIENT_INVENTORY`). Use database row-level locking (`SELECT ... FOR UPDATE`) or optimistic concurrency control (`version` increment).
- **Product Visibility:** Only products with status `ACTIVE` can be added to a cart or purchased. `DRAFT` or `ARCHIVED` products must be rejected.

### Cart Rules
- **Single Active Cart:** A user may only have one `ACTIVE` cart at a time.
- **Quantity Bounds:** A single line item quantity must be between `1` and a configurable max (e.g., `99`). Adding an already-present product increments its quantity rather than creating a duplicate row.
- **Live Validation on Checkout:** Cart items reflect live product prices and availability until checkout converts them into an immutable Order.

### Order & Checkout Rules (ACID Transactions)
- **Atomic Checkout:** Order creation, OrderItem insertion, Inventory deduction/reservation, and Cart status update (`ACTIVE` -> `CONVERTED`) **must** execute inside a single ACID database transaction. If any step fails, the entire transaction rolls back.
- **Historical Price Snapshotting:** `OrderItem` must snapshot `unit_price_cents` and `product_name` at the moment of purchase. Future price changes or product renames must never alter historical orders.
- **Idempotent Checkout:** Checkout requests require an `Idempotency-Key`. Retrying the same request due to network failure must return the existing order without double-charging or double-deducting inventory.
- **State Machine Enforcement:** Orders follow strict state transitions:
  - `PENDING` -> `PAID` or `CANCELLED`
  - `PAID` -> `SHIPPED` or `CANCELLED`
  - `SHIPPED` -> Terminal state (cannot be cancelled directly; requires a return flow)
  - Cancelling a `PENDING` or `PAID` order must atomically restore the deducted inventory.

---

## 5. Validation, Error Handling & Testing
- **Structured Errors:** Never return raw database errors or generic `500` strings. Use a consistent error envelope (following RFC 7807 Problem Details):
  ```json
  {
    "error": {
      "code": "INSUFFICIENT_INVENTORY",
      "message": "Requested 3 units of SKU-101, but only 1 is available.",
      "details": { "sku": "SKU-101", "requested": 3, "available": 1 }
    }
  }