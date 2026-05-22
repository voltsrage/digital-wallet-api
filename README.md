# Digital Wallet API

A production-quality fintech backend for managing user accounts, processing money transfers, and maintaining an immutable financial record. Built on one constraint that drives every architectural decision: **money must never be created or destroyed**. Every debit has a corresponding credit, and every state change is auditable.

## Features

- **Authentication** — JWT access tokens (15 min) + refresh tokens (7 days) stored in Redis with rotation on every use
- **Account Lockout** — failed login attempts counted atomically per user; account locked for 30 minutes after 10 consecutive failures; `LOGIN_LOCKED` audit event written on trigger
- **IP Velocity Check** — failed logins counted per IP in Redis (10 per 5 min); throws 429 before password comparison so timing reveals nothing about email validity; catches credential stuffing that never trips the per-account lockout
- **Account Management** — open, view, freeze, unfreeze, and close accounts; status enforced as a state machine (`active → frozen → active`; `closed` is terminal)
- **Money Transfers** — double-entry bookkeeping in a single `SERIALIZABLE` PostgreSQL transaction; deadlock prevention via consistent account lock ordering; idempotency key stored atomically inside the transfer transaction
- **Transfer Velocity Gate** — Redis fixed-window counter (20 transfers / 10 min per user); enforced before any database work
- **New Beneficiary Gate** — Redis counter limits new recipients to 3 per 10 minutes; known recipients (prior completed transfer exists) bypass the counter entirely; catches the account-takeover cash-out pattern
- **Balance Caching** — Redis cache with 30-second TTL on account reads; explicitly invalidated on every balance-changing write
- **Transaction Ledger** — cursor-paginated ledger entries with a SQL window function running balance; safe to query mid-history; `balance_after` is always the authoritative stored value
- **Account Summary** — daily aggregated credits, debits, and net over a caller-specified date range; defaults to the last 30 days; `DATE_TRUNC` grouping with `FILTER` aggregates in a single pass
- **Outbox Pattern** — MongoDB receipts and audit events written asynchronously via a background poller; survives process crashes between PostgreSQL commit and MongoDB write
- **Transaction Receipts** — rich MongoDB documents with denormalized account metadata, device metadata, and flexible `Mixed` schema for extensible fields
- **Audit Trail** — append-only MongoDB documents enforced immutable at the application layer via Mongoose middleware hooks; no update or delete path exists
- **Fraud Detection** — three-layer architecture: Redis pre-transfer gates → daily volume check inside the SERIALIZABLE transaction → async fraud scorer writing to MongoDB; five signal types with tiered risk scoring
- **Admin Role** — `role` column on `users`; `requireAdmin` middleware does a live DB lookup on each admin request so role changes take effect immediately without requiring re-login
- **Reconciliation** — nightly background job verifying two invariants: (1) global ledger net is zero (all credits minus all debits = 0); (2) every account's stored balance matches the sum of its ledger entries; writes `GLOBAL_LEDGER_IMBALANCE` / `RECONCILIATION_FAILURE` audit events as daily-deduped upserts; logs at `fatal` level for monitoring
- **Structured Logging** — Pino with per-request correlation IDs; `userId`, `accountId`, `transferId` as structured fields
- **API Docs** — Swagger UI at `/swagger` (development only)

## Architecture

```
HTTP request  → Express (routes → controllers → services)
                     │
          ┌──────────┴──────────┐
          ▼                     ▼
    PostgreSQL              MongoDB
  (users, accounts,      (receipts, audit
   transfers, ledger,     events, fraud
   outbox events)         signals)
          │
          └── Outbox poller (every 5 s) ──► MongoDB writes
                    │
                Redis
          (balance cache, refresh
           tokens, rate limits,
           velocity counters)
```

The core transfer flow is a single `SERIALIZABLE` PostgreSQL transaction. MongoDB writes happen after the commit via an outbox table — the outbox row is written inside the same transaction, so it is durable even if the process dies before the MongoDB write completes. The background poller reads unprocessed events with `FOR UPDATE SKIP LOCKED`, making it safe to run multiple poller instances concurrently.

### Fraud Detection Layers

```
Incoming request
      │
      ▼
Layer 1 — Hard gates (Redis, synchronous, before any DB work)
  checkFailedLoginIpVelocity   ← auth path (10 failures / 5 min per IP)
  checkTransferVelocity        ← transfer path (20 transfers / 10 min per user)
  checkNewBeneficiaryVelocity  ← transfer path (3 new recipients / 10 min per user)
      │ pass
      ▼
Layer 2 — PostgreSQL transaction
  daily volume check           ← inside SERIALIZABLE trx
      │ commit
      ▼
Layer 3 — Async fraud scorer (outbox handler → MongoDB FraudSignal)
  VELOCITY             — transfers in the last 10-minute window
  LARGE_AMOUNT         — transfer as % of daily limit (≥50% medium, ≥80% high)
  NEW_RECIPIENT        — first-ever transfer to this destination
  DESTINATION_FUNNEL   — many distinct senders to one recipient in 30 min (AML indicator)
  RECENT_PASSWORD_RESET — transfer within 60 min of a password reset (account takeover)
      │
      ▼
Risk score → allow (<30) / review (30–65) / hold (65–100) / block (≥100)
```

Layer 1 returns immediately without any PostgreSQL work. Layer 3 is the right place for checks that require joins, aggregates, or cross-document lookups too slow for the hot path.

## Tech Stack

| Layer | Technology |
|---|---|
| Server | Node.js, Express 4 |
| SQL Database | PostgreSQL (Knex.js 3 — query builder, not ORM) |
| Document Database | MongoDB (Mongoose 9) |
| Cache / Sessions | Redis (ioredis 5) |
| Auth | JWT (`jsonwebtoken`), bcrypt (12 rounds) |
| Financial Precision | `decimal.js` — never native JS floats |
| Logging | Pino + pino-http |
| Docs | Swagger UI (`swagger-jsdoc`) |

## Project Structure

```
src/
├── index.js                       # Server startup, DB connections, outbox poller start
├── app.js                         # Express middleware chain + route mounting
├── swagger.js                     # OpenAPI spec setup
├── db/
│   ├── knex.js                    # PostgreSQL connection (Knex)
│   ├── mongo.js                   # MongoDB connection (Mongoose)
│   └── redis.js                   # Shared Redis client (ioredis)
├── models/                        # Mongoose schemas (MongoDB)
│   ├── TransactionReceipt.js      # Rich transfer metadata; unique index on transferId
│   ├── AuditEvent.js              # Immutable audit log; hooks block all updates/deletes
│   └── FraudSignal.js             # Per-transfer fraud assessment; unique index on transferId
├── routes/
│   ├── auth.js                    # Auth endpoints
│   ├── account.js                 # Account CRUD + state transitions + ledger
│   ├── transfer.js                # Transfer initiation + retrieval + fraud signal
│   └── health.js                  # Liveness + readiness endpoints
├── controllers/
│   ├── authController.js          # Thin layer — delegates to services
│   ├── accountController.js
│   ├── transferController.js
│   └── ledgerController.js        # Ledger entries + account summary
├── services/
│   ├── authService.js             # Register, login, refresh, logout + lockout + IP velocity
│   ├── accountService.js          # Account CRUD, state machine, balance cache
│   ├── transferService.js         # Core transfer: SERIALIZABLE tx, double-entry, idempotency
│   ├── ledgerService.js           # Cursor-paginated ledger + daily summary aggregates
│   ├── fraudSignal.service.js     # Async fraud scorer: signal evaluation + risk scoring
│   ├── outboxPoller.js            # Background poller — FOR UPDATE SKIP LOCKED every 5 s
│   ├── outboxHandlers.js          # Writes receipts, audit events, and fraud signals to MongoDB
│   ├── reconciliationService.js   # Two-check invariant verification: global net + per-account balance
│   └── reconciliationJob.js       # Scheduler — once per day in production; RECONCILIATION_INTERVAL_MS overrides
├── middleware/
│   ├── authenticate.js            # JWT verification for HTTP routes
│   ├── requireAdmin.js            # Live DB role check — role changes effective immediately
│   ├── correlationId.js           # Per-request UUID injected into all log lines
│   └── errorHandler.js            # Global error handler → standard envelope
├── errors/
│   └── AppError.js                # Custom error classes (Validation, NotFound, Forbidden, …)
├── utils/
│   ├── ApiResponse.js             # Standard { success, statusCode, data, error } envelope
│   ├── tokens.js                  # JWT sign/verify + refresh token Redis storage
│   ├── balanceCache.js            # Redis balance cache (get / set / invalidate)
│   ├── velocityCheck.js           # Redis velocity gates: transfer, new beneficiary, login IP
│   ├── withSerializableRetry.js   # Retry wrapper for SERIALIZABLE serialization failures
│   └── logger.js                  # Pino instance
└── seed/
    └── seed.js                    # Development seed data
tests/
└── unit/                          # Jest unit tests; dependencies mocked with jest.unstable_mockModule
migrations/
├── 20260507020548_create_users.js
├── 20260507020614_create_accounts.js
├── 20260507022112_create_transfers.js
├── 20260507022123_create_ledger_entries.js
├── 20260507025618_create_outbox_events.js
├── 20260511034625_add_role_to_users.js
└── 20260511072453_add_password_reset_at_to_users.js
```

## Architecture Decisions

### Double-Entry Bookkeeping

Every transfer writes exactly two ledger entries — a debit (money leaving) and a credit (money arriving) — in the same database transaction. The net across all entries must always equal zero.

```
Transfer: Alice sends $50 to Bob

Ledger entry 1:  Alice's account  DEBIT   $50   (balance: $200 → $150)
Ledger entry 2:  Bob's account    CREDIT  $50   (balance: $100 → $150)

Net change: -$50 + $50 = $0 ✓
```

The reconciliation job (Phase 9) verifies this invariant nightly.

### SERIALIZABLE Isolation Level

Transfers run at `SERIALIZABLE`, not the PostgreSQL default `READ COMMITTED`. At `READ COMMITTED`, two concurrent transfers from the same account could both read the same balance, both decide there are sufficient funds, and both deduct — producing a negative balance. `SERIALIZABLE` detects the read-write conflict and aborts one transaction. The aborted transaction is retried by `withSerializableRetry` (up to 3 attempts) before surfacing a `503` to the client.

### Deadlock Prevention via Consistent Lock Ordering

A transfer locks two rows. If two concurrent transfers involve the same two accounts in opposite directions, each could hold one lock and wait for the other — a deadlock. The fix: always acquire locks sorted by account ID regardless of which is source and destination.

```javascript
const [firstId, secondId] = [fromAccountId, toAccountId].sort();
await trx('accounts').whereIn('id', [firstId, secondId]).orderBy('id').forUpdate();
```

Both transactions attempt locks in the same order, so one waits while the other completes.

### Outbox Pattern (Distributed Transaction Problem)

PostgreSQL and MongoDB do not share a transaction manager. Writing to both inside a single request creates the dual write problem: if the process dies between the PostgreSQL commit and the MongoDB write, the receipt is never written.

Solution: write an `outbox_events` row inside the PostgreSQL transfer transaction. A background poller reads unprocessed events with `FOR UPDATE SKIP LOCKED` and writes them to MongoDB, then marks them processed. If the poller crashes after writing to MongoDB but before marking processed, the MongoDB write is a `$setOnInsert` upsert — running it twice is a no-op.

### DECIMAL(18,8) Not FLOAT

`0.1 + 0.2` in IEEE 754 floating point is `0.30000000000000004`. Across millions of transfers, these errors accumulate. `DECIMAL(18,8)` stores exact decimal values. The application layer uses `decimal.js` for all arithmetic — JavaScript's `Number` type has the same float problem. Monetary values are sent and received over the API as strings, not numbers.

### Knex.js Instead of a Full ORM

Knex is used as a query builder, not a full ORM. For financial logic, understanding exactly what SQL runs against the database matters. Knex query expressions map closely to SQL, and the transfer and window-function queries use `knex.raw()` directly. Mongoose is still used for MongoDB because its schema validation and middleware hooks (used to enforce `AuditEvent` immutability) are genuine value-adds.

### Immutable Audit Events

`AuditEvent` Mongoose middleware throws on any attempt to call `.save()` on an existing document, `.deleteOne()`, `.deleteMany()`, `.updateOne()`, `.updateMany()`, or `.findOneAndUpdate()`. Any developer who accidentally tries to mutate an audit record gets an immediate application-layer error, not a silent data loss.

### JWT with Refresh Token Rotation

Access tokens are short-lived (15 min) and verified by signature — no database lookup per request. Refresh tokens are stored in Redis and revocable. On each refresh, the old token is deleted and a new one is issued, limiting the exposure window if a token is intercepted.

### Reconciliation — Two-Invariant Design

The reconciliation job verifies two properties that must always hold:

1. **Global net is zero** — the sum of every credit minus every debit across all ledger entries must equal `0`. A non-zero net means money was created or destroyed somewhere in the system.
2. **Per-account balance consistency** — for every account, the stored `accounts.balance` column must equal the ledger sum (`SUM(credits) - SUM(debits)` for that account). A mismatch means the account column diverged from the immutable ledger record.

Both failures are handled the same way: log at `logger.fatal()` (surfaces as a critical alert in any structured log pipeline) and write a daily-deduped audit event via `$setOnInsert` upsert so that a job that runs multiple times in one day does not produce duplicate records.

The job runs once per day in production (`RECONCILIATION_INTERVAL_MS` defaults to `86400000`). Setting `RECONCILIATION_INTERVAL_MS=60000` in development runs it every minute. A mutex flag (`isRunning`) prevents overlapping runs if a previous check is still executing.

### Admin Role — Live DB Lookup

The `requireAdmin` middleware fetches the user's role from PostgreSQL on every admin request rather than embedding it in the JWT. This means role changes (grant or revoke) take effect immediately without requiring the user to log out. The cost is one extra query per admin call — acceptable given how rarely admin endpoints are called.

### Cursor Pagination on the Ledger

The ledger endpoint uses opaque base64url-encoded cursors (ISO timestamps) rather than `OFFSET`. `OFFSET n` requires the database to scan and discard the first `n` rows on every page — cost grows linearly with page depth. A cursor filters by `created_at < :cursor`, which uses the existing `(account_id, created_at DESC)` index directly.

---

## Getting Started

### Prerequisites

- Node.js 18+
- PostgreSQL 14+
- MongoDB 6+
- Redis 7+

### Install

```bash
npm install
```

### Configure

```bash
cp .env.example .env
```

Edit `.env`:

```env
POSTGRES_URL=postgresql://admin:password@localhost:5432/digital_wallet
MONGO_URI=mongodb://mongoUser:password@localhost:27017/digital_wallet?authSource=admin
NODE_ENV=development
REDIS_URL=redis://localhost:6379
JWT_SECRET=change-me-in-production
JWT_REFRESH_SECRET=another-secret-change-me-in-production
LOG_LEVEL=info
PORT=3095
# Optional: override reconciliation interval (ms). Default 86400000 (once per day).
# Set to 60000 in development to run every minute.
# RECONCILIATION_INTERVAL_MS=60000
```

### Migrate

```bash
npm run migrate:latest
```

### Seed (optional)

```bash
npm run seed
```

### Run

```bash
# Development (auto-reload)
npm run dev

# Production
npm start
```

API docs available at `http://localhost:3095/swagger` (development only).

### Test

```bash
npm test
```

Unit tests live in `tests/unit/`. Jest is configured for ESM via `--experimental-vm-modules`. All infrastructure dependencies (PostgreSQL, MongoDB, Redis) are mocked at the module level with `jest.unstable_mockModule`, so no running services are required.

---

## API Reference

All endpoints are prefixed `/api/v1`. Authenticated routes require:

```
Authorization: Bearer <access_token>
```

Responses follow a standard envelope:

```json
{ "success": true, "statusCode": 200, "data": {}, "error": null }
```

### Auth

| Method | Path | Auth | Description |
|---|---|---|---|
| POST | `/auth/register` | — | Register user, returns access + refresh tokens |
| POST | `/auth/login` | — | Login; IP velocity check fires first; increments failure counter, locks after 10 failures |
| POST | `/auth/refresh` | — | Rotate refresh token, return new token pair |
| POST | `/auth/logout` | — | Revoke refresh token (idempotent — always 200) |

### Accounts

| Method | Path | Auth | Description |
|---|---|---|---|
| POST | `/accounts` | ✓ | Open a new account (defaults to USD) |
| GET | `/accounts` | ✓ | List all accounts for the authenticated user |
| GET | `/accounts/:id` | ✓ | Get account details; reads from Redis balance cache |
| POST | `/accounts/:id/freeze` | ✓ | Freeze account (`active → frozen`) |
| POST | `/accounts/:id/unfreeze` | ✓ | Unfreeze account (`frozen → active`) |
| POST | `/accounts/:id/close` | ✓ | Close account (`active/frozen → closed`); requires zero balance |
| GET | `/accounts/:id/ledger` | ✓ | Cursor-paginated ledger entries with running balance |
| GET | `/accounts/:id/summary` | ✓ | Daily aggregated credits/debits/net over a date range |

**Ledger query parameters:**

| Parameter | Type | Default | Description |
|---|---|---|---|
| `before` | string | now | Opaque cursor from the previous response's `nextCursor` |
| `limit` | integer | 50 | Page size (max 100) |

**Summary query parameters:**

| Parameter | Type | Default | Description |
|---|---|---|---|
| `from` | ISO 8601 | 30 days ago | Start of the date range (inclusive) |
| `to` | ISO 8601 | now | End of the date range (exclusive) |

### Transfers

| Method | Path | Auth | Description |
|---|---|---|---|
| POST | `/transfers` | ✓ | Initiate a transfer (idempotency key required) |
| GET | `/transfers/:id` | ✓ | Get transfer details and associated ledger entries |
| GET | `/transfers/:id/receipt` | ✓ | Get the MongoDB receipt for a completed transfer |
| GET | `/transfers/:id/fraud-signal` | ✓ admin | Get the fraud signal document for a transfer |

### Health

These endpoints are not prefixed with `/api/v1` and require no authentication. They are intended for load balancers and orchestrators.

| Method | Path | Description |
|---|---|---|
| GET | `/health` | Liveness — `200` if the process is running |
| GET | `/health/ready` | Readiness — checks PostgreSQL, MongoDB, and Redis; `503` if any fail |

**Readiness response (healthy):**

```json
{ "status": "ok", "checks": { "postgres": "ok", "mongo": "ok", "redis": "ok" } }
```

**Readiness response (degraded):**

```json
{ "status": "degraded", "checks": { "postgres": "ok", "mongo": "error", "redis": "ok" } }
```

**Transfer request body:**

```json
{
  "fromAccountId": "uuid",
  "toAccountId": "uuid",
  "amount": "50.00",
  "currency": "USD",
  "description": "Rent payment",
  "idempotencyKey": "client-generated-uuid"
}
```

`amount` must be a positive decimal string with at most 8 decimal places. Amounts are always returned as strings.

---

## Data Models

### PostgreSQL

**users**
```
id                  UUID        PK, gen_random_uuid()
email               VARCHAR     unique
password_hash       VARCHAR     never returned in responses
display_name        VARCHAR     nullable
status              VARCHAR     active | locked | suspended
role                VARCHAR(20) default 'user'; 'admin' grants access to admin endpoints
failed_login_count  INTEGER     default 0
locked_until        TIMESTAMPTZ nullable
password_reset_at   TIMESTAMPTZ nullable; written by the password-reset endpoint (Phase 9+)
created_at / updated_at
```

**accounts**
```
id             UUID          PK
user_id        UUID          → users
account_number VARCHAR       unique (ACC-XXXXXXXX)
currency       VARCHAR(3)    default USD
balance        DECIMAL(18,8) default 0
status         VARCHAR       active | frozen | closed
daily_limit    DECIMAL(18,8) default 10000
version        INTEGER       optimistic lock counter
created_at / updated_at
```

Indexes: `account_number` (unique), `user_id`

**transfers**
```
id               UUID          PK
from_account_id  UUID          → accounts
to_account_id    UUID          → accounts
amount           DECIMAL(18,8)
currency         VARCHAR(3)
description      VARCHAR(500)  nullable
status           VARCHAR       pending | completed | failed | reversed
idempotency_key  VARCHAR       unique
created_at
```

Indexes: `idempotency_key` (unique), `(from_account_id, created_at DESC)`, `(to_account_id, created_at DESC)`

**ledger_entries**
```
id            UUID          PK
account_id    UUID          → accounts
transfer_id   UUID          → transfers
type          VARCHAR       debit | credit
amount        DECIMAL(18,8)
balance_after DECIMAL(18,8) snapshot at time of entry
created_at
```

Indexes: `(account_id, created_at DESC)` (compound), `transfer_id`

**outbox_events**
```
id          UUID     PK
event_type  VARCHAR
payload     JSONB
processed   BOOLEAN  default false
created_at  TIMESTAMPTZ
```

Partial index: `(processed, created_at) WHERE processed = false` — only indexes pending rows, stays small as history accumulates.

### MongoDB

**TransactionReceipt**
```
transferId          String    unique — links to PostgreSQL transfers.id
fromAccountNumber   String    denormalized at write time
toAccountNumber     String    denormalized at write time
fromUserDisplayName String    denormalized at write time
toUserDisplayName   String    denormalized at write time
amount              Decimal128
currency            String
description         String    nullable
metadata            Mixed     { ipAddress, userAgent, ... extensible without migration }
tags                [String]
createdAt           Date
```

**AuditEvent** *(immutable — application enforces no updates or deletes)*
```
eventType   String  enum: ACCOUNT_CREATED | ACCOUNT_FROZEN | ACCOUNT_UNFROZEN |
                          ACCOUNT_CLOSED | TRANSFER_COMPLETED | TRANSFER_DEBIT |
                          TRANSFER_CREDIT | TRANSFER_FAILED | TRANSFER_REVERSED |
                          LOGIN_SUCCESS | LOGIN_FAILED | LOGIN_LOCKED |
                          RECONCILIATION_FAILURE | GLOBAL_LEDGER_IMBALANCE
actorId     String  userId or "system"
targetId    String  accountId, transferId, or userId
targetType  String  account | transfer | user | ledger
payload     Mixed   full snapshot at event time
ipAddress   String  nullable
userAgent   String  nullable
createdAt   Date    indexed
```

Indexes: `{ targetId, createdAt desc }`, `{ eventType, createdAt desc }`

**FraudSignal** *(one document per transfer)*
```
transferId  String    unique — links to PostgreSQL transfers.id
userId      String    sender's userId
riskScore   Number    sum of signal weights; no cap (3 high = 120)
decision    String    allow | review | hold | block
signals     Array     [ { type, severity: low|medium|high, detail: Mixed } ]
              signal types: VELOCITY | LARGE_AMOUNT | NEW_RECIPIENT |
                            DESTINATION_FUNNEL | RECENT_PASSWORD_RESET
createdAt   Date
```

Indexes: `{ transferId: 1 }` (unique), `{ userId: 1, createdAt: -1 }`

Risk score weights: low=10, medium=25, high=40. Decision thresholds: allow <30, review 30–65, hold 65–100, block ≥100.

---

## Outbox Poller

The poller runs every 5 seconds inside the API process. It is safe to run multiple instances — `FOR UPDATE SKIP LOCKED` ensures each event is processed by exactly one worker.

```
Poll cycle:
  1. Open PostgreSQL transaction
  2. SELECT ... WHERE processed = false ORDER BY created_at LIMIT 50 FOR UPDATE SKIP LOCKED
  3. For each event: call handler → write to MongoDB → mark processed = true
  4. Commit
  5. On any failure: log error, swallow exception, retry on next tick
```

MongoDB writes are idempotent upserts (`$setOnInsert`) — if the poller processes the same event twice (crash after MongoDB write, before marking processed), the second write is a no-op.

---

## Implemented Phases

| Phase | Feature |
|---|---|
| 1 | PostgreSQL schema + Knex migrations |
| 2 | MongoDB schemas + Mongoose models (TransactionReceipt, AuditEvent, FraudSignal) |
| 3 | JWT authentication + refresh token rotation + account lockout |
| 4 | Account management + Redis balance caching with invalidation |
| 5 | Money transfers — double-entry, SERIALIZABLE, deadlock prevention, idempotency |
| 6 | Outbox pattern + MongoDB receipt and audit event writes |
| 7 | Transaction ledger endpoint — cursor pagination, SQL window function running balance, daily account summary |
| 8 | Fraud detection — transfer velocity gate, daily volume check, VELOCITY / LARGE_AMOUNT / NEW_RECIPIENT async signals |
| 8b | Layered fraud signals — IP login velocity, new beneficiary gate, DESTINATION_FUNNEL / RECENT_PASSWORD_RESET signals, expanded risk tiers (allow/review/hold/block), admin role + fraud signal endpoint |
| 9 | Nightly reconciliation job — global ledger net check + per-account balance verification; `GLOBAL_LEDGER_IMBALANCE` / `RECONCILIATION_FAILURE` audit events; unit test suite (Jest, ESM, module-level mocks) |
| 10 | Health checks — `GET /health` liveness + `GET /health/ready` readiness (PostgreSQL + MongoDB + Redis); `503` on any dependency failure |

## Roadmap

| Phase | Feature |
|---|---|
| 11 | Docker Compose + Nginx |
| 12 | CI/CD pipeline |
| 13 | Git hygiene |
