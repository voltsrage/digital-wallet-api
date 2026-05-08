# PRD: Digital Wallet API

## Overview

A fintech backend for managing user accounts, processing money transfers, and maintaining an immutable financial record. The project is built around one constraint that drives every architectural decision: **money must never be created or destroyed**. Every debit must have a corresponding credit, and every state change must be auditable.

The dual-database design is not arbitrary. PostgreSQL owns everything where correctness is non-negotiable — balances, ledger entries, idempotency. MongoDB owns everything where flexibility and append-only semantics are more important than relational integrity — receipts, audit events, fraud signals. Redis handles ephemeral concerns — caching, rate limiting, idempotency key locks.

This project maps directly to `sd-senior-006` (Payment System Design), `db-mid-002` (Isolation Levels), `db-mid-005` (Deadlocks), `db-mid-004` (Window Functions), and `db-senior-004` (Distributed Transactions).

**Stack:** Node.js, Express, Knex.js (PostgreSQL), Mongoose (MongoDB), Redis, Pino → Seq, Jest, Docker Compose, Nginx, GCP VM, GitLab CI/CD.

---

## Goals

- Implement double-entry bookkeeping and understand why it is the foundation of all financial systems
- Practice SQL at the query level — Knex.js is used as a query builder and migration tool, not a full ORM that hides SQL
- Understand the distributed transaction problem across two databases and implement the outbox pattern as the solution
- Practice transaction isolation levels and deadlock prevention in a context where getting them wrong has visible, testable consequences
- Produce a project that directly answers the `sd-senior-006` payment system design question

## Non-Goals

- Card payment processing (no Stripe integration)
- Multi-currency conversion
- KYC document upload
- Regulatory reporting

---

## Why SQL and NoSQL — The Boundary

This is the central design question. The rule is:

**Use PostgreSQL for anything where two rows must be consistent with each other.** Account balances and ledger entries must always agree. A transfer must either fully complete or fully roll back. These are relational concerns that require foreign keys, transactions, and strong isolation.

**Use MongoDB for anything that is a record of something that happened.** Receipts, audit events, and fraud signals describe events that have already been committed to PostgreSQL. They need flexible schemas (fraud signals have different shapes for different fraud types), they are never updated, and they do not need to be consistent with each other — they just need to exist.

| Data | Database | Reason |
|---|---|---|
| Users, accounts, balances | PostgreSQL | ACID required — balance must match ledger sum |
| Ledger entries | PostgreSQL | Append-only but must be transactionally linked to balance updates |
| Idempotency keys | PostgreSQL | Must be checked and written atomically in the same transaction as the transfer |
| Transaction receipts | MongoDB | Rich, flexible metadata per transaction; no relational constraints needed |
| Audit events | MongoDB | Append-only immutable log; flexible payload per event type |
| Fraud signals | MongoDB | Variable schema per signal type; written asynchronously after the fact |
| Notifications | MongoDB | Ephemeral enrichment data; no consistency requirement |
| Balance cache | Redis | Read performance; TTL-bounded staleness |
| Idempotency key locks | Redis | Distributed lock during in-flight processing |
| Rate limiting | Redis | Sliding window counters |
| Session tokens | Redis | Refresh token storage with TTL |

---

## API Conventions

Same envelope as the Fleet Telemetry and Team Chat APIs.

**Success:**
```json
{
  "success": true,
  "statusCode": 200,
  "data": { },
  "error": null
}
```

**Error:**
```json
{
  "success": false,
  "statusCode": 422,
  "data": null,
  "error": {
    "message": "Insufficient funds.",
    "code": "INSUFFICIENT_FUNDS"
  }
}
```

All list endpoints use offset pagination (`?page=1&pageSize=20`) except transaction history, which uses cursor pagination on `created_at` for the same reason as message history in the Team Chat API.

---

## Domain Model

A **user** holds one or more **accounts**. An account has a single currency and a current balance.

A **transfer** moves money from one account to another. It produces exactly two **ledger entries** — a debit on the source account and a credit on the destination account. The transfer and both ledger entries are written in a single database transaction.

A **transaction receipt** is a MongoDB document written after the PostgreSQL transfer commits. It holds enriched metadata about the transfer that does not belong in the relational schema.

An **audit event** is an immutable MongoDB document written for every state change in the system — account creation, transfers, freezes, logins, failed attempts.

---

## Features

### 1. Authentication

Same JWT + Redis refresh token pattern as the Team Chat API. Access token: 15 minutes. Refresh token: 7 days, revocable via Redis delete.

**Additional fintech concern:** Failed login attempts are counted in Redis per IP and per user. After 10 consecutive failures, the user account is locked for 30 minutes and an audit event is written. This is a compliance pattern — financial applications must detect and respond to brute-force attempts.

**Concepts practiced:** Auth patterns from the Team Chat API plus account lockout as a security control.

---

### 2. Account Management

**Description:** Users can open accounts, view balances, and freeze or close their own accounts. An account can only be closed if its balance is zero.

**Endpoints:**
- `POST /api/v1/accounts` — open a new account
- `GET /api/v1/accounts` — list own accounts
- `GET /api/v1/accounts/:id` — get account details and current balance
- `POST /api/v1/accounts/:id/freeze` — freeze account (no transfers in or out)
- `POST /api/v1/accounts/:id/close` — close account (balance must be zero)

**Balance caching:** The current balance is cached in Redis with a 30-second TTL. It is invalidated immediately on any transfer involving the account. The `GET /api/v1/accounts/:id` endpoint reads from cache when available.

**Concepts practiced:** Soft state management (active/frozen/closed as a state machine), cache invalidation on write, why you cannot close an account with a non-zero balance (orphaned funds).

---

### 3. Money Transfers

**Description:** The core feature. Transfer money between two accounts. This is where every major fintech concept converges.

**Endpoints:**
- `POST /api/v1/transfers` — initiate a transfer
- `GET /api/v1/transfers/:id` — get transfer status and details

**Request shape:**
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

**What happens inside a successful transfer (one database transaction):**

1. Acquire a row-level lock on both accounts ordered by account ID (lowest ID first — deadlock prevention)
2. Check source account status is `active`
3. Check source account balance >= amount
4. Deduct from source account balance; record balance version increment
5. Add to destination account balance; record balance version increment
6. Insert a debit ledger entry for the source account
7. Insert a credit ledger entry for the destination account
8. Insert an idempotency key record with the transfer ID
9. Commit

**State machine:**

```
PENDING → COMPLETED
        → FAILED (insufficient funds, frozen account, validation error)
        → REVERSED (initiated after completion, e.g. dispute)
```

State transitions are stored as new rows, not updates. The current state is the latest row for a given transfer ID.

**After the PostgreSQL transaction commits:**

10. Write a TransactionReceipt to MongoDB (see Feature 4)
11. Write two AuditEvents to MongoDB — one for the debit, one for the credit
12. Invalidate Redis balance cache for both accounts

Steps 10–12 happen after the commit via the **outbox pattern** (see Design Decisions). If they fail, the money has still moved correctly — the receipt and audit trail are eventually consistent.

**Idempotency:** The idempotency key is checked before processing. If a matching key already exists, the stored transfer ID is returned immediately without processing again. The key lookup and the transfer write happen in the same transaction — atomicity prevents two concurrent requests with the same key from both processing.

**Concepts practiced:** Double-entry bookkeeping, database transactions, row-level locking, deadlock prevention via consistent lock ordering, optimistic vs pessimistic concurrency, idempotency, state machine design, isolation levels.

---

### 4. Transaction Receipts (MongoDB)

**Description:** After a transfer commits in PostgreSQL, a rich receipt document is written to MongoDB. The receipt carries data that has no relational structure — device metadata, geolocation if available, tags applied by the user, notes.

**Schema:**
```javascript
{
  _id:                  ObjectId,
  transferId:           String,    // matches PostgreSQL transfer id
  fromAccountNumber:    String,    // denormalized
  toAccountNumber:      String,    // denormalized
  fromUserDisplayName:  String,    // denormalized
  toUserDisplayName:    String,    // denormalized
  amount:               Decimal128,
  currency:             String,
  description:          String,
  metadata: {
    deviceId:           String,
    ipAddress:          String,
    userAgent:          String,
    // ... any future fields without schema migration
  },
  tags:                 [String],
  createdAt:            Date
}
```

**Endpoints:**
- `GET /api/v1/transfers/:id/receipt` — get the full receipt for a transfer

**Why MongoDB here:** The `metadata` object has no fixed schema. New fields can be added without a migration. PostgreSQL `JSONB` could store this too, but that would mix flexible schema data into the same table as the strictly-typed financial data, blurring the boundary between the two databases.

**Concepts practiced:** Denormalization in document databases, schema flexibility as a first-class feature of MongoDB, the difference between a PostgreSQL `JSONB` column and a MongoDB document.

---

### 5. Audit Trail (MongoDB)

**Description:** An append-only log of every state change in the system. Audit events are never updated or deleted. They exist as a compliance record and as the canonical answer to "what happened to this account?"

**Schema:**
```javascript
{
  _id:        ObjectId,
  eventType:  String,  // e.g. "TRANSFER_COMPLETED", "ACCOUNT_FROZEN", "LOGIN_FAILED"
  actorId:    String,  // userId or "system"
  targetId:   String,  // accountId, transferId, or userId
  targetType: String,  // "account" | "transfer" | "user"
  payload:    Object,  // full snapshot at the time of the event
  ipAddress:  String,
  userAgent:  String,
  createdAt:  Date     // indexed — primary query field
}
```

**Key constraint:** Once written, an audit event is immutable. There is no update or delete endpoint. MongoDB's `_id` is used as a natural insert-order guarantee.

**Endpoints:**
- `GET /api/v1/accounts/:id/audit` — paginated audit history for an account (cursor pagination on `createdAt`)
- `GET /api/v1/admin/audit?targetId={id}&eventType={type}` — admin query (protected route)

**Index:**
```javascript
{ targetId: 1, createdAt: -1 }   // primary query pattern
{ eventType: 1, createdAt: -1 }  // admin queries by event type
```

**Concepts practiced:** Event sourcing (audit log as the source of truth for what happened), append-only data, why `updatedAt` is insufficient for compliance (it only records the last change, not the history).

---

### 6. Transaction History and Window Functions

**Description:** A paginated ledger view showing every entry on an account with running balance. This is where SQL window functions are practiced.

**Endpoints:**
- `GET /api/v1/accounts/:id/ledger?before={cursor}&limit=50` — cursor-paginated ledger entries

**The window function query:**
```sql
SELECT
  id,
  type,
  amount,
  balance_after,
  description,
  created_at,
  SUM(CASE WHEN type = 'credit' THEN amount ELSE -amount END)
    OVER (ORDER BY created_at ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW)
    AS running_balance
FROM ledger_entries
WHERE account_id = $1
  AND created_at < $2
ORDER BY created_at DESC
LIMIT $3;
```

**Additional analytics endpoint:**
- `GET /api/v1/accounts/:id/summary?from={iso}&to={iso}` — aggregate spend, income, and net over a date range

This query uses `GROUP BY` with `DATE_TRUNC` to group entries by day, plus `FILTER` to separate debits from credits in the same aggregation.

**Concepts practiced:** SQL window functions (`SUM OVER`, `ROW_NUMBER`, `LAG`), `DATE_TRUNC` for time bucketing, cursor pagination on financial ledger data, the difference between storing `balance_after` on each entry (fast reads, denormalized) vs computing it from the sum (always correct, slower).

---

### 7. Fraud Signals (MongoDB + Redis)

**Description:** After every transfer, a lightweight fraud check runs asynchronously. It writes a fraud signal document to MongoDB recording the risk assessment. Redis is used to detect velocity patterns (many small transfers in a short window) in real time before the transfer commits.

**Pre-transfer Redis check (synchronous, inside the transfer flow):**
- `ratelimit:transfer:{userId}` — if more than 20 transfers in the last 10 minutes, return `429`
- `ratelimit:transfer:amount:{userId}` — if total transfer volume in the last 24 hours exceeds the account's daily limit, return `422`

**Post-transfer MongoDB write (asynchronous, via outbox):**
```javascript
{
  _id:           ObjectId,
  transferId:    String,
  userId:        String,
  riskScore:     Number,   // 0–100
  decision:      String,   // "allow" | "review" | "block"
  signals: [
    { type: "VELOCITY", severity: "low",  detail: { count: 5, window: "10m" } },
    { type: "NEW_RECIPIENT", severity: "medium", detail: { firstTransfer: true } }
  ],
  createdAt: Date
}
```

**Concepts practiced:** Pre-transfer vs post-transfer checks, Redis for real-time velocity detection, MongoDB for flexible fraud metadata, why the fraud signal schema varies per signal type (different fields for velocity vs new recipient vs large amount).

---

### 8. Reconciliation Job

**Description:** A nightly background job that verifies the ledger is balanced. It checks that for every transfer, the sum of all debit entries equals the sum of all credit entries. Any discrepancy is written as a critical audit event and an alert is logged to Seq.

**The invariant (SQL):**
```sql
SELECT
  SUM(CASE WHEN type = 'credit' THEN amount ELSE 0 END) AS total_credits,
  SUM(CASE WHEN type = 'debit'  THEN amount ELSE 0 END) AS total_debits,
  SUM(CASE WHEN type = 'credit' THEN amount ELSE -amount END) AS net
FROM ledger_entries;
-- net must always equal 0 in a correctly balanced ledger
```

It also verifies that every account's stored `balance` column matches the sum of its ledger entries:
```sql
SELECT
  a.id,
  a.balance AS stored_balance,
  SUM(CASE WHEN l.type = 'credit' THEN l.amount ELSE -l.amount END) AS computed_balance
FROM accounts a
JOIN ledger_entries l ON l.account_id = a.id
GROUP BY a.id, a.balance
HAVING a.balance != SUM(CASE WHEN l.type = 'credit' THEN l.amount ELSE -l.amount END);
```

Any rows returned by this query represent a data integrity violation.

**Concepts practiced:** Financial reconciliation as a correctness guarantee, aggregate SQL over large datasets, using a nightly job to surface silent data corruption, why both `balance` (fast reads) and the ledger (source of truth) must agree.

---

### 9. Health Checks

- `GET /health` — liveness: `200` if the process is running
- `GET /health/ready` — readiness: checks PostgreSQL, MongoDB, and Redis; returns `503` if any fail

---

## PostgreSQL Schema

```sql
CREATE TABLE users (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  email           VARCHAR(255) NOT NULL,
  password_hash   VARCHAR(255) NOT NULL,
  display_name    VARCHAR(100),
  status          VARCHAR(20)  NOT NULL DEFAULT 'active', -- active | locked | suspended
  failed_login_count INTEGER   NOT NULL DEFAULT 0,
  locked_until    TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX idx_users_email ON users (email);

CREATE TABLE accounts (
  id           UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID          NOT NULL REFERENCES users(id),
  account_number VARCHAR(20) NOT NULL,
  currency     VARCHAR(3)    NOT NULL DEFAULT 'USD',
  balance      DECIMAL(18,8) NOT NULL DEFAULT 0,
  status       VARCHAR(20)   NOT NULL DEFAULT 'active', -- active | frozen | closed
  daily_limit  DECIMAL(18,8) NOT NULL DEFAULT 10000,
  version      INTEGER       NOT NULL DEFAULT 0,  -- optimistic lock counter
  created_at   TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX idx_accounts_number   ON accounts (account_number);
CREATE        INDEX idx_accounts_user_id  ON accounts (user_id);

CREATE TABLE transfers (
  id               UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  from_account_id  UUID          NOT NULL REFERENCES accounts(id),
  to_account_id    UUID          NOT NULL REFERENCES accounts(id),
  amount           DECIMAL(18,8) NOT NULL,
  currency         VARCHAR(3)    NOT NULL,
  description      VARCHAR(500),
  status           VARCHAR(20)   NOT NULL DEFAULT 'pending',
  idempotency_key  VARCHAR(255)  NOT NULL,
  created_at       TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX idx_transfers_idempotency ON transfers (idempotency_key);
CREATE        INDEX idx_transfers_from_acct  ON transfers (from_account_id, created_at DESC);
CREATE        INDEX idx_transfers_to_acct    ON transfers (to_account_id,   created_at DESC);

CREATE TABLE ledger_entries (
  id            UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id    UUID          NOT NULL REFERENCES accounts(id),
  transfer_id   UUID          NOT NULL REFERENCES transfers(id),
  type          VARCHAR(10)   NOT NULL,  -- debit | credit
  amount        DECIMAL(18,8) NOT NULL,
  balance_after DECIMAL(18,8) NOT NULL,  -- snapshot at time of entry
  created_at    TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_ledger_account_time ON ledger_entries (account_id, created_at DESC);
CREATE INDEX idx_ledger_transfer     ON ledger_entries (transfer_id);

-- Outbox table: events queued for MongoDB after PostgreSQL commit
CREATE TABLE outbox_events (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type   VARCHAR(100) NOT NULL,
  payload      JSONB        NOT NULL,
  processed    BOOLEAN      NOT NULL DEFAULT false,
  created_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_outbox_unprocessed ON outbox_events (processed, created_at)
  WHERE processed = false;
```

---

## Design Decisions

### Double-Entry Bookkeeping

Every transfer writes exactly two ledger entries: a debit (money leaving) and a credit (money arriving). They are always equal in amount. This is not an opinion — it is the foundation of all accounting systems since the 15th century.

The invariant: the sum of all credits minus the sum of all debits across the entire ledger must equal zero. If it does not, money has been created or destroyed, which means there is a bug.

```
Transfer: Alice sends $50 to Bob

Ledger entry 1:  Alice's account  DEBIT   $50   (balance: $200 → $150)
Ledger entry 2:  Bob's account    CREDIT  $50   (balance: $100 → $150)

Net change: -$50 + $50 = $0 ✓
```

### The Distributed Transaction Problem

PostgreSQL and MongoDB do not share a transaction manager. After the PostgreSQL transfer commits, the API must write the receipt and audit events to MongoDB. If the API process dies between the PostgreSQL commit and the MongoDB write, the receipt never gets written.

This is the **dual write problem**: two databases must both be updated, but there is no atomic way to do it.

The **outbox pattern** is the solution:

1. Inside the PostgreSQL transaction, write the event payload to the `outbox_events` table alongside the transfer
2. Commit the PostgreSQL transaction — both the transfer and the outbox event are durable
3. A background poller reads unprocessed outbox events and writes them to MongoDB
4. On success, mark the outbox event as `processed = true`

The poller is idempotent — if it processes the same event twice (e.g. it crashes after writing to MongoDB but before marking processed), the MongoDB write is a no-op (upsert on `transferId`).

The outbox table index `WHERE processed = false` ensures the poller only scans pending rows, not the entire table.

### Transaction Isolation Level for Transfers

The transfer runs at `SERIALIZABLE` isolation, not the default `READ COMMITTED`.

At `READ COMMITTED`, two concurrent transfers from the same account could both read the same balance, both decide there are sufficient funds, and both deduct — producing a negative balance. This is a **phantom read** scenario.

`SERIALIZABLE` prevents this by aborting one of the concurrent transactions when it detects a read-write conflict. The aborted transaction must be retried by the application.

```javascript
await knex.transaction(async (trx) => {
  await trx.raw('SET TRANSACTION ISOLATION LEVEL SERIALIZABLE');
  // ... transfer logic
});
```

This is slower than `READ COMMITTED` but correct. For financial transactions, correctness is not negotiable.

### Deadlock Prevention via Consistent Lock Ordering

A transfer locks two rows (source account, destination account). If Alice is sending to Bob at the same time Bob is sending to Alice, both transactions may try to lock the accounts in opposite order — each holds one lock and waits for the other. This is a deadlock.

The fix: always lock accounts in the same order regardless of which is source and which is destination. Sort by account ID before acquiring locks:

```javascript
const [first, second] = [fromAccountId, toAccountId].sort();
await trx('accounts').where('id', first).forUpdate();
await trx('accounts').where('id', second).forUpdate();
```

Now both concurrent transactions attempt to acquire locks in the same order, so one waits while the other completes.

### DECIMAL(18,8) Not FLOAT

Floating-point arithmetic is unsuitable for money. `0.1 + 0.2` in IEEE 754 floating point is `0.30000000000000004`, not `0.3`. On a single transaction this is invisible, but across millions of transactions these errors accumulate.

`DECIMAL(18,8)` stores exact decimal values. The 8 decimal places allow for sub-cent precision (needed for some currency conversions and interest calculations). In JavaScript, use the `decimal.js` library for arithmetic — JavaScript's `Number` type is a double-precision float and has the same problem.

### `balance_after` Stored on Each Ledger Entry

Each ledger entry stores a `balance_after` snapshot. This means the balance at any point in history is readable without summing the entire ledger — a `SELECT` on one row rather than a `SUM` over potentially millions.

The trade-off: if there is a bug that writes an incorrect balance, `balance_after` and the computed balance diverge. The reconciliation job detects this. This is an acceptable trade-off — fast reads, correctness verified nightly.

### Knex.js Instead of a Full ORM

Knex.js is used for PostgreSQL instead of Prisma or TypeORM. The reason: SQL matters in fintech, and an ORM that generates queries on your behalf obscures what is running against the database. Writing Knex query builder expressions — which map closely to SQL — means you understand the query. For the window function and reconciliation queries, raw SQL is used directly via `knex.raw()`.

Mongoose is still used for MongoDB because the document validation and hook system are genuinely valuable there.

### Financial Amounts as Strings in the API

The API accepts and returns monetary amounts as strings (`"50.00"`), not numbers (`50.00`). This prevents JavaScript's floating-point representation from corrupting the value before it reaches the database layer. The string is parsed into `decimal.js` for arithmetic and stored as `DECIMAL(18,8)` in PostgreSQL.

---

## System Design Constraints

These numbers are the anchor for every architectural decision in the project. In an interview, you will be asked *why* you made specific choices — "why not Kafka?", "why not read replicas?", "why not sharding?" The honest answer is always: **it depends on the scale**. These constraints define the scale.

### Load Profile

| Metric | Value | Derivation |
|---|---|---|
| Registered users | 500K | Seed assumption |
| Daily active users | 100K | 20% DAU/MAU ratio, typical for fintech |
| Transfers per day | 200K | 2 transfers per DAU on average |
| Average transfer rate | **2.3 TPS** | 200K / 86,400 seconds |
| Peak transfer rate | **20 TPS** | 10× average during business hours (9am–5pm) |
| Ledger rows written/day | 400K | 2 ledger entries per transfer |
| Audit events written/day | ~500K | Transfers + logins + account changes |
| Outbox events written/day | ~600K | Receipts + audit events + fraud signals |

### Latency Targets

| Endpoint | P50 | P95 | P99 |
|---|---|---|---|
| `POST /transfers` | 150ms | 400ms | 800ms |
| `GET /accounts/:id` (cache hit) | 10ms | 30ms | 60ms |
| `GET /accounts/:id` (cache miss) | 40ms | 100ms | 200ms |
| `GET /accounts/:id/ledger` | 50ms | 150ms | 300ms |
| `POST /auth/login` | 80ms | 200ms | 400ms |

Transfer latency budget breakdown: ~5ms Redis idempotency check + ~80ms PostgreSQL SERIALIZABLE transaction (including row locks) + ~10ms outbox insert + ~20ms network/framework overhead.

### Availability and Durability

| Concern | Target | Notes |
|---|---|---|
| Uptime SLA | 99.9% | ~8.7 hours downtime/year |
| RTO (Recovery Time Objective) | 30 minutes | Time to restore service after failure |
| RPO (Recovery Point Objective) | **0** | No financial data loss is acceptable — ever |
| PostgreSQL backup | Point-in-time recovery, WAL archiving | GCP managed PostgreSQL |
| MongoDB backup | Daily snapshot + oplog | 7-year retention (financial compliance) |
| Outbox event retention | 30 days after `processed = true` | Purged by nightly cleanup job |
| Ledger retention | Indefinite | Cannot delete financial records |
| Audit event retention | 7 years | Standard financial regulatory requirement |

### Concurrency and Connection Limits

| Resource | Limit | Reason |
|---|---|---|
| PostgreSQL connection pool | 20 connections | Standard for a single Node.js instance; SERIALIZABLE transactions hold connections longer than READ COMMITTED |
| Redis connections | 10 per instance | Low — Redis operations are microsecond-latency |
| Outbox poller instances | 1 active (horizontally safe via `FOR UPDATE SKIP LOCKED`) | Multiple pollers are safe but one is sufficient at this TPS |
| Nginx worker connections | 1024 | Default; more than sufficient for 20 TPS |

### Data Volume at 1 Year

| Table / Collection | Row Count | Estimated Size |
|---|---|---|
| `ledger_entries` (PostgreSQL) | ~146M rows | ~25 GB |
| `transfers` (PostgreSQL) | ~73M rows | ~8 GB |
| `audit_events` (MongoDB) | ~180M documents | ~50 GB |
| `transaction_receipts` (MongoDB) | ~73M documents | ~15 GB |
| `fraud_signals` (MongoDB) | ~73M documents | ~10 GB |
| `outbox_events` (PostgreSQL, live) | <50K rows (purged) | <100 MB |

At these volumes, all queries remain fast because every primary query path hits an index on a bounded key (`account_id`, `transfer_id`, `created_at` with cursor). A full table scan would be catastrophic at 146M rows — which is why `EXPLAIN ANALYZE` and index verification are in the build checklist.

### Why Not X — Decisions the Constraints Justify

These questions will come up in system design interviews. The constraint numbers are what make the answers defensible.

**Why not Kafka instead of the outbox pattern?**
At 20 TPS peak, the outbox table processes at most 60 events/second (3 MongoDB writes per transfer). A single PostgreSQL `SELECT ... FOR UPDATE SKIP LOCKED` poller handles this comfortably. Adding Kafka would introduce a new infrastructure dependency, a consumer group, offset management, and dead-letter queue handling — for no throughput benefit at this scale. The crossover point where Kafka makes sense is roughly 1,000+ events/second sustained, or when multiple independent consumers need to subscribe to the same event stream.

**Why not PostgreSQL read replicas?**
The balance cache (Redis, 30-second TTL) already absorbs the majority of `GET /accounts/:id` reads. The remaining reads are low-volume. More importantly, read replicas introduce replication lag — a user who just made a transfer might read a stale balance from a replica. For financial data, that creates a support surface ("I made a transfer but my balance is wrong") that outweighs the read throughput benefit at 100K DAU.

**Why not database sharding?**
At 20 TPS peak and 500K users, a single PostgreSQL instance on a GCP `db-standard-4` (4 vCPU, 15 GB RAM) handles this load with headroom. Sharding by `user_id` would break cross-account transactions — a transfer between two users on different shards cannot be done in a single ACID transaction. The correct migration path at higher scale is: read replicas first, then vertical scaling, then — only if those are exhausted — a sharding or CQRS architecture that separates the write path from the read path.

**Why not `REPEATABLE READ` instead of `SERIALIZABLE`?**
`REPEATABLE READ` prevents dirty reads and non-repeatable reads but does not prevent phantom reads. Two concurrent transfers from the same account could both pass the balance check under `REPEATABLE READ` if one has not yet committed. `SERIALIZABLE` detects this read-write conflict and aborts one transaction. At 20 TPS, the retry overhead is negligible. At 5,000+ TPS with heavily contended accounts, you would investigate optimistic locking or account-level queuing as alternatives.

**Why not a message queue for fraud signal processing?**
Fraud signals are written after the transfer commits, via the outbox poller, asynchronously. They do not block the user response. The outbox is already doing this work. Adding a separate message queue for fraud specifically would add operational complexity without changing the user-facing latency.

---

| Concern | Target |
|---|---|
| Correctness | Ledger balance must equal sum of entries at all times — verified by nightly reconciliation |
| Isolation | `SERIALIZABLE` for all transfer transactions |
| Idempotency | Every transfer endpoint requires `Idempotency-Key` header; duplicate requests return stored result |
| Auth | JWT (15 min) + Redis refresh token (7 days); account lockout after 10 failed logins |
| Precision | All monetary values as `DECIMAL(18,8)` in PostgreSQL; `decimal.js` in application layer; strings over the wire |
| Logging | Pino → Seq; `userId`, `accountId`, `transferId`, `correlationId` as structured properties |
| API docs | Swagger at `/swagger` in development |
| Health checks | `GET /health`, `GET /health/ready` (PostgreSQL + MongoDB + Redis) |
| Testing | Unit tests for transfer business logic and reconciliation invariant; integration tests for idempotency and deadlock scenarios |
| Outbox | Background poller runs every 5 seconds; retries failed MongoDB writes up to 5 times before logging a critical alert |
| CI/CD | GitLab CI: lint → test → migrate (Knex) → deploy |

---

## Build Order

| Phase | Feature | Concepts Practiced |
|---|---|---|
| 1 | PostgreSQL schema + Knex migrations | SQL schema design, financial precision, migration workflow |
| 2 | MongoDB schemas + Mongoose models | Audit trail design, append-only documents, denormalization |
| 3 | Express setup + auth + account lockout | Auth patterns, lockout as a security control |
| 4 | Account management + Redis caching | Balance cache with invalidation |
| 5 | Money transfers (core) | Double-entry, transactions, isolation levels, deadlock prevention, idempotency |
| 6 | Outbox pattern + MongoDB receipt/audit writes | Distributed transaction problem, eventual consistency |
| 7 | Transaction ledger + window functions | `SUM OVER`, `DATE_TRUNC`, cursor pagination |
| 8 | Fraud signals + Redis velocity checks | Pre- vs post-transfer checks, variable-schema documents |
| 9 | Reconciliation job | Aggregate SQL, correctness verification, alerting on invariant violation |
| 10 | Health checks | Liveness vs readiness, three-database connectivity |
| 11 | Docker Compose + Nginx + GCP VM | Container networking, deployment |
| 12 | GitLab CI/CD | Knex migration in pipeline, deploy gate |
| 13 | Git hygiene | Merge requests, linear history |

---

## Step-by-Step Guide

---

### Phase 1 — PostgreSQL Schema and Knex Migrations

**What to do:**
1. Read `db-mid-002` (Isolation Levels) and `db-mid-005` (Deadlocks) before writing any code. The schema decisions in this phase are directly motivated by those concepts.
2. Sketch the five tables on paper. For each column that stores money, write `DECIMAL(18,8)` — never `FLOAT` or `NUMERIC` without precision. Write down why.
3. Create the Knex migration files. Knex migrations work the same as EF Core migrations: `knex migrate:make create_accounts`, then implement `up()` and `down()`.
4. Add indexes with explicit reasoning: why does `transfers` need an index on `(from_account_id, created_at DESC)` but `ledger_entries` does not need one on `type`?
5. Seed: two users, two accounts each, and a set of transfers that produce a balanced ledger. Verify balance by running the reconciliation query manually.
6. Run `EXPLAIN ANALYZE` on the ledger query (`WHERE account_id = X ORDER BY created_at DESC LIMIT 50`). Confirm index usage.

**Why:**
The `outbox_events` table with its partial index (`WHERE processed = false`) is worth spending time on. A partial index only indexes rows that match the condition — as processed events accumulate, the index stays small because it never indexes the majority of rows. This is a production technique that is rarely taught explicitly.

---

### Phase 2 — MongoDB Schemas and Mongoose Models

**What to do:**
1. Define Mongoose schemas for `TransactionReceipt`, `AuditEvent`, and `FraudSignal`.
2. For `AuditEvent`, add a Mongoose middleware hook that prevents updates and deletes — any call to `.save()` on an existing document or `.deleteOne()` should throw. This enforces immutability at the application layer.
3. Add indexes: `{ targetId: 1, createdAt: -1 }` on `AuditEvent`, `{ transferId: 1 }` unique on `TransactionReceipt`.
4. Run `.explain("executionStats")` on the audit query for a given `targetId`. Confirm the compound index is used.

**Why:**
Enforcing audit event immutability in Mongoose middleware means any developer who accidentally tries to update an audit event gets an immediate error — the application protects the compliance data, not just a policy document.

---

### Phase 3 — Auth and Account Lockout

**What to do:**
1. Implement the same JWT + refresh token pattern as the Team Chat API.
2. Add the account lockout: on each failed login, `UPDATE users SET failed_login_count = failed_login_count + 1 WHERE id = $1`. If the count reaches 10, set `locked_until = NOW() + INTERVAL '30 minutes'` and write a `LOGIN_LOCKED` audit event to MongoDB.
3. On successful login, reset `failed_login_count = 0`.
4. On any login attempt, check `locked_until > NOW()` before attempting password verification — do not reveal whether the account exists to a locked-out attacker.

**Why:**
The account lockout is both a security control and a data integrity exercise — it uses a conditional update pattern that must handle concurrent login attempts correctly. Two concurrent failed logins must not both read `count = 9`, both decide not to lock, and both increment to 10 without triggering the lockout.

---

### Phase 4 — Account Management and Balance Caching

**What to do:**
1. Build the account CRUD endpoints.
2. Cache `GET /api/v1/accounts/:id` balance in Redis with a 30-second TTL.
3. On any transfer that involves the account, `DEL balance:{accountId}` to invalidate the cache.
4. Enforce the close constraint: `DELETE` (soft) is only permitted if `balance = 0`. Return `422` with code `ACCOUNT_HAS_BALANCE` otherwise.
5. Implement account status as a state machine: `active → frozen → active` is allowed; `closed` is terminal.

**Why:**
The 30-second TTL means a user who just made a transfer might see a stale balance for up to 30 seconds if the cache is not explicitly invalidated. Invalidating on write eliminates this. Understanding the difference between TTL-based expiry (eventual consistency) and explicit invalidation (immediate consistency) is a real trade-off question.

---

### Phase 5 — Money Transfers

**What to do:**
1. Before writing any code, re-read `db-mid-002` on isolation levels and `db-mid-005` on deadlocks. Write down in plain English what goes wrong if you use `READ COMMITTED` for this operation.
2. Implement the transfer in a single `SERIALIZABLE` Knex transaction following the exact sequence in the Features section.
3. Lock accounts in sorted order by ID. Write a comment explaining why.
4. Implement idempotency key handling: check for an existing key at the start of the transaction. If found, return the stored transfer. If not, insert the key as part of the same transaction.
5. Test the deadlock scenario: write a test that fires two concurrent transfers in opposite directions between the same two accounts. Confirm neither transaction deadlocks — one completes and one is retried.
6. Test the insufficient funds scenario: confirm the balance never goes negative.
7. Test the idempotency scenario: send the same request twice with the same key. Confirm only one transfer is created.

**Why:**
This is the highest-stakes phase of the project. Every concept from `db-mid-002` and `db-mid-005` becomes testable here. A deadlock is not a theoretical concern — if the locking order is wrong, the test will actually deadlock (or one transaction will be aborted). Seeing it fail, fixing the lock order, and watching it pass is the most direct way to understand why consistent lock ordering matters.

---

### Phase 6 — Outbox Pattern

**What to do:**
1. Inside the PostgreSQL transfer transaction, write to `outbox_events` instead of calling MongoDB directly.
2. Build a background poller (`setInterval` every 5 seconds) that reads all rows where `processed = false`, writes each event to MongoDB, and marks the row `processed = true`.
3. Use `FOR UPDATE SKIP LOCKED` on the outbox query to prevent two poller instances from processing the same event.
4. Make the MongoDB writes idempotent: `updateOne({ transferId }, { $setOnInsert: payload }, { upsert: true })` — if the document already exists, do nothing.
5. Test the failure path: kill the API between the PostgreSQL commit and the MongoDB write. Restart it. Confirm the outbox poller picks up the pending event and writes it to MongoDB.

**Why:**
The outbox pattern is the standard solution to the dual write problem. Step 3 (`FOR UPDATE SKIP LOCKED`) is a PostgreSQL feature specifically designed for job queues — it atomically locks and skips already-locked rows, preventing two workers from processing the same job. This is worth understanding in detail because it appears in any system that uses a database as a queue.

---

### Phase 7 — Transaction Ledger and Window Functions

**What to do:**
1. Read `db-mid-004` (Window Functions) before building this endpoint.
2. Implement the ledger endpoint. Write the window function query in raw SQL via `knex.raw()`. Run it against seed data and verify the running balance is correct for each row.
3. Use `EXPLAIN ANALYZE` to verify the compound index `(account_id, created_at DESC)` is used. Check the estimated vs actual row counts.
4. Add the summary endpoint using `DATE_TRUNC('day', created_at)` to group entries by day. Separate debits from credits in the same query using `SUM(amount) FILTER (WHERE type = 'debit')`.
5. Compare the running balance from the window function against the `balance_after` column stored on each row. They must match. If they do not, you have found a bug.

**Why:**
Window functions are one of the most powerful SQL features and one of the most commonly undertested. The `FILTER` clause on an aggregate is less well-known but eliminates the need for a subquery or two separate aggregations. Running both and seeing the results match is the verification that `balance_after` denormalization is correct.

---

### Phase 8 — Fraud Signals

**What to do:**
1. Add the Redis velocity check to the transfer endpoint: before the PostgreSQL transaction begins, check the rate limit counter. If exceeded, return `429` without touching the database.
2. After the outbox writer processes a completed transfer event, also write a `FraudSignal` document to MongoDB. Compute a simple risk score based on: transfer amount relative to daily limit (larger = higher risk), whether this is the first transfer to this recipient, and transfer velocity in the last hour.
3. Expose `GET /api/v1/transfers/:id/fraud-signal` as an admin-only endpoint.

**Why:**
The pre-transfer Redis check is synchronous — it protects the database from the burst before any SQL runs. The post-transfer MongoDB write is asynchronous — it records the risk assessment without blocking the user's response. Understanding which checks belong where (synchronous vs asynchronous, Redis vs MongoDB) is a system design decision that comes up in any fraud or risk context.

---

### Phase 9 — Reconciliation Job

**What to do:**
1. Implement the reconciliation job as a background service that runs on a schedule (nightly in production, every minute in development for testing).
2. Run the two reconciliation queries: the global net (must equal zero) and the per-account balance check (stored balance must match computed balance).
3. If any discrepancy is found: log a structured critical-level entry to Seq with full details, write a `RECONCILIATION_FAILURE` audit event to MongoDB, and do not auto-correct — surface it for human review.
4. Write a test that intentionally creates a discrepancy (directly update a balance column without writing a ledger entry) and verify the reconciliation job detects it.

**Why:**
A reconciliation job that silently passes is not useful. Testing that it actually detects the problem it is designed to find is the only way to trust it. This is a testing principle that applies beyond fintech: test that your safety nets catch failures, not just that they do not produce false positives.

---

### Phases 10–13

Follow the same process as the Fleet Telemetry and Team Chat APIs for health checks, Docker Compose deployment, GitLab CI/CD, and Git hygiene. The Knex migration step in the CI pipeline follows the same principles as the `.NET` migration strategy — see `docs/projects/database-migration-strategy.md` for the general approach; apply it with `knex migrate:latest` in the `migrate` stage.

---

## Self-Review Checklist (per MR)

- [ ] Are all monetary values stored as `DECIMAL(18,8)` in PostgreSQL and handled with `decimal.js` in application code?
- [ ] Are monetary amounts sent and received as strings over the API, not numbers?
- [ ] Is every transfer wrapped in a `SERIALIZABLE` transaction?
- [ ] Are accounts locked in sorted order by ID to prevent deadlocks?
- [ ] Is the idempotency key inserted inside the transfer transaction, not before or after?
- [ ] Does the outbox poller use `FOR UPDATE SKIP LOCKED`?
- [ ] Are MongoDB audit event writes upserted (idempotent), not blindly inserted?
- [ ] Is the `AuditEvent` Mongoose schema preventing updates and deletes?
- [ ] Does `EXPLAIN ANALYZE` confirm index usage on the ledger and transfer queries?
- [ ] Does the reconciliation job actually detect a manually injected balance discrepancy?
- [ ] Are all log calls using Pino structured properties with `transferId` and `accountId`?
- [ ] Is `passwordHash` excluded from all User response shapes?

---

## Success Criteria

The project is complete when:

1. The global ledger invariant holds: sum of all credits minus sum of all debits equals zero
2. The concurrent transfer deadlock test passes: two opposite transfers between the same accounts complete without deadlock
3. The idempotency test passes: the same transfer request sent twice produces one transfer record
4. The outbox pattern survives a mid-operation crash: killing the process between PostgreSQL commit and MongoDB write results in eventual MongoDB consistency after restart
5. The reconciliation job detects an injected balance discrepancy
6. `EXPLAIN ANALYZE` confirms index scans on all primary query paths
7. Window function query produces correct running balances verified against `balance_after` column
8. `GET /health/ready` returns `503` when any one of the three databases is stopped
9. The GitLab CI/CD pipeline runs lint → test → migrate → deploy on merge to `main`
10. You can explain: why `SERIALIZABLE`, why sorted lock order, why the outbox pattern, why `DECIMAL` not `FLOAT`, and why both databases are needed
