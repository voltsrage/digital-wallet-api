# DigitalWalletAPI — Interview Questions by Level

This document maps each major interview question this project can answer to the specific phases and implementation details that support a strong answer.

---

## Junior

---

### "Why don't you store passwords in plaintext? What is hashing?"

**Phase**: 3

Hashing is a one-way transformation — you can turn a password into a hash, but you cannot reverse the hash back into the password. When a user logs in, you hash what they typed and compare it to the stored hash. If they match, the password is correct — the original password never needs to be stored.

The project uses bcrypt with 12 rounds. bcrypt is deliberately slow — the "rounds" setting controls how expensive the hash computation is. This matters because if the database is compromised and an attacker gets all the hashes, they'd have to brute-force each one individually. bcrypt's cost makes that prohibitively slow.

Why 12 rounds specifically: it's a balance between security and login latency. Lower rounds hash faster but are more crackable; higher rounds are more secure but make every login slow. 12 is the industry standard for a good trade-off.

---

### "What is JWT and how does token-based authentication work?"

**Phase**: 3

JWT (JSON Web Token) is a compact, signed token that encodes a payload (like a user ID) and lets a server verify it was issued by itself — without looking anything up in a database. The server signs the token with a secret key on login, and on every subsequent request, it verifies the signature to trust the contents.

The project uses two separate tokens:

- **Access token**: Short-lived (15 minutes). Sent with every API request. If stolen, expires quickly.
- **Refresh token**: Long-lived (7 days). Only sent to the `/auth/refresh` endpoint to get a new access token. Stored in Redis so it can be explicitly revoked.

Two separate JWT secrets are used (one for access, one for refresh). This matters: if the access token secret were reused, a compromised access token could potentially be used to forge a refresh token, granting indefinite access.

---

### "What is a database index and why do you use one?"

**Phase**: 1

Without an index, a database query like `SELECT * FROM users WHERE email = 'x@example.com'` must scan every row in the table. With 10 million users, that's slow. An index is a pre-built lookup structure (like a book's index) that lets the database jump directly to matching rows.

The project uses several types:

- **Unique index** on `users.email` — enforces uniqueness and makes login lookups fast
- **Compound index** on `(account_id, created_at DESC)` for ledger entries — matches the primary query pattern: "get all ledger entries for account X, newest first"
- **Partial index** on `outbox_events WHERE processed = false` — only indexes unprocessed rows. As processed events accumulate (potentially millions), they don't bloat the index or slow down the outbox worker's poll query

The verification step: run `EXPLAIN ANALYZE` on the ledger query and confirm no `Seq Scan` appears — the planner must use the index.

---

### "What is pagination and why is it necessary?"

**Phases**: 4, 7

Pagination limits query results to a manageable page size so the API doesn't load millions of rows into memory on every request. Without it, `GET /accounts/:id/ledger` on an old account with 500,000 entries would scan all 500,000 rows, serialize them all to JSON, and send it across the network — likely timing out or exhausting memory.

The project uses two styles:

- **Offset pagination** (Phase 4, account lists): Simple `LIMIT n OFFSET m`. Fine for small result sets that don't change frequently.
- **Cursor pagination** (Phase 7, ledger): Uses a timestamp as an opaque cursor (`before=<base64url-encoded ISO timestamp>`). The query adds `AND created_at < ?` instead of `OFFSET`. This is critical for ledger history — `OFFSET 100000` on a 500,000-row table still scans 100,000 rows to skip them; a cursor doesn't.

---

### "What is a state machine and when do you use one?"

**Phase**: 4

A state machine defines a fixed set of states for an entity and which transitions between states are allowed. Instead of letting arbitrary status changes through, you enforce that only valid progressions happen.

Account statuses:

```
active → frozen
active → closed
frozen → active
frozen → closed
closed → (nothing — terminal)
```

A request to unfreeze an already-active account throws `INVALID_STATUS_TRANSITION` (422). A request to reopen a closed account is also rejected. Without this, you'd have to scatter validation logic across every endpoint; with a state machine, invalid transitions are caught in one place.

The closed state being terminal also enforces a business rule: once closed, an account can't be accidentally reopened by a bug or a stale client.

---

### "What is caching and why would you cache a database result?"

**Phase**: 4

Caching stores a computed or fetched result in fast storage (Redis) so subsequent requests don't repeat the same expensive work. The project caches account rows in Redis with a 30-second TTL.

Why account data specifically: every transfer, freeze, and close operation starts by fetching the account row. Under load, this is the same row read repeatedly. Serving it from Redis (sub-millisecond) instead of PostgreSQL (network round-trip + disk) reduces database load and latency.

The TTL acts as a safety net — if the invalidation logic misses a case, the stale data self-heals within 30 seconds. But the project also does **explicit invalidation**: every write operation calls `invalidateAccountCache(accountId)` immediately after the database write. This means the next read always gets fresh data, not a stale 30-second-old snapshot.

---

### "What is idempotency and why does it matter for money transfers?"

**Phase**: 5

Idempotency means the same operation can be safely called multiple times and produce the same result. For money transfers, this is critical: if a client sends a transfer request and the network drops before it gets the response, it will retry — but the server may have already processed it. Without idempotency, the user gets charged twice.

The project enforces it with a unique database constraint on `transfers.idempotency_key`. The client generates a unique key per intended transfer and sends it with the request. If the transfer already exists with that key, the existing record is returned without creating a new one. The `23505` (unique violation) PostgreSQL error code is caught and used to look up and return the original transfer.

---

## Mid-Level

---

### "Why do you use DECIMAL instead of float for financial calculations?"

**Phase**: 1

JavaScript's `Number` type is a 64-bit IEEE 754 float. Floats cannot represent all decimal fractions exactly. The classic example: `0.1 + 0.2 === 0.30000000000000004`. In a financial system, rounding errors accumulate — a $0.00000001 error per transaction becomes meaningful across millions.

The project addresses this at every layer:

- **PostgreSQL**: `DECIMAL(18,8)` stores exact decimal values. 18 total digits, 8 after the decimal — enough precision for micro-transactions in crypto or financial instruments.
- **JavaScript**: The `decimal.js` library (or equivalent Decimal object) is used for all arithmetic. `new Decimal(src.balance).minus(amount)` is always safe; `src.balance - amount` is never used.
- **API responses**: Balance and amount fields are returned as **strings** (`"750.00000000"`) rather than numbers. This prevents JSON serialization from introducing float representation errors in the client.

The `Decimal.isZero()` check for account closure handles all zero representations (`"0"`, `"0.0"`, `"0.00000000"`) correctly — a plain `=== 0` or `=== "0.00000000"` would miss some cases.

---

### "What is double-entry bookkeeping and how do you implement it?"

**Phases**: 1, 5, 9

Double-entry bookkeeping is an accounting principle: every transaction records two equal-and-opposite entries. A debit from one account must have a corresponding credit to another. The sum of all debits and all credits across the entire ledger must always equal zero.

The project implements this with a `ledger_entries` table. Every transfer creates exactly two rows in the same database transaction:

```
{ account_id: src,  transfer_id: X, type: 'debit',  amount: 100 }
{ account_id: dest, transfer_id: X, type: 'credit', amount: 100 }
```

Both rows are inserted atomically inside the SERIALIZABLE transaction that also updates both account balances. If the transaction rolls back, neither ledger entry exists — you never get half a transfer.

Each entry also stores `balance_after` — the account balance at the moment the entry was written. This creates an immutable, point-in-time snapshot for every balance state the account has ever been in, without needing to replay all transactions.

The reconciliation job (Phase 9) verifies the invariant: `SUM(credits) - SUM(debits)` across the entire table must be zero. Any discrepancy indicates a data integrity bug.

---

### "What is the cache-aside pattern?"

**Phase**: 4

Cache-aside (also called lazy loading) means the application manages the cache manually:

1. On read: check the cache first. If hit, return cached value. If miss, fetch from DB, write to cache, return.
2. On write: update the DB, then invalidate (or update) the cache.

The project's `getAccount` function follows this exactly:

```
check redis → hit? return parsed JSON → miss? query postgres → write to redis → return
```

The alternative — write-through (update cache on every DB write) — works but means reads that never happen still populate the cache, wasting memory. Cache-aside only caches what's actually read.

The project uses both TTL (30 seconds) and explicit invalidation. TTL alone would mean stale balance data lingers for up to 30 seconds after a transfer. Explicit invalidation (`redis.del`) in the transfer service means the cache is cleared immediately after every balance change — the next read gets the real updated balance from PostgreSQL.

---

### "What is the Outbox pattern and why use it here?"

**Phase**: 6

The Outbox pattern solves a dual-write problem: after a transfer completes in PostgreSQL, you need to write a receipt and audit events to MongoDB. If you write to MongoDB directly in the HTTP handler, two things can go wrong: the write can fail (leaving PostgreSQL with a transfer and MongoDB without a receipt), or the application crashes between the two writes.

The solution: write an `outbox_events` row to PostgreSQL inside the same transaction as the transfer. Since it's the same transaction, either everything (transfer + ledger entries + outbox event) commits or none of it does. MongoDB gets written asynchronously by a background poller.

The outbox poller runs every 5 seconds, queries for `WHERE processed = false LIMIT 50 FOR UPDATE SKIP LOCKED`, processes each event (writing to MongoDB), then marks it `processed = true` — all inside a single Knex transaction. If the application crashes before marking processed, the event survives and is retried on restart. If the MongoDB write fails, the transaction rolls back and the event retries next tick.

This gives eventual consistency: transfer durability is immediate (PostgreSQL), MongoDB follows within seconds.

---

### "How do you implement account lockout securely?"

**Phase**: 3

Account lockout prevents brute-force password guessing by temporarily blocking login after too many failures. The tricky parts are doing it atomically and without leaking information.

**Atomicity**: Two concurrent failed login requests could both read `failed_login_count = 9`, both increment to 10, and both decide not to lock (each thinks it's the 10th, but neither actually set the lock). The project solves this with a single atomic SQL statement:

```sql
UPDATE users SET
  failed_login_count = failed_login_count + 1,
  locked_until = CASE WHEN failed_login_count + 1 >= 10
                 THEN NOW() + INTERVAL '30 minutes'
                 ELSE locked_until END
WHERE id = ?
```

The database performs the read-increment-conditional-lock in one operation. No race window exists.

**Ordering**: The lockout check (`locked_until > NOW()`) runs before `bcrypt.compare`. If you do bcrypt first and then check the lock, you've done expensive bcrypt work on every brute-force attempt. Checking the lock first short-circuits without hashing.

**Information security**: The API returns the same `401` message for "user not found", "wrong password", and "account locked". Different messages would tell an attacker which accounts exist and which are locked.

---

### "How does refresh token rotation work and why do you revoke tokens in Redis?"

**Phase**: 3

Refresh token rotation means: every time a refresh token is used, it's immediately invalidated and a new one is issued. The old token can never be used again.

The project stores a token identifier (`jti`, a UUID) in Redis with key `refresh:{userId}:{tokenId}`. When a client sends a refresh token:

1. Verify JWT signature
2. Extract `userId` and `jti`
3. Check that `refresh:{userId}:{jti}` exists in Redis
4. Delete it (invalidate old token)
5. Issue new access + refresh tokens (new `jti` stored in Redis)

Why Redis instead of just trusting the JWT signature? JWTs are stateless — a valid signature means the token is valid. Without Redis, there's no way to invalidate a stolen refresh token before its 7-day expiry. Redis lets you revoke a specific token instantly, and `redis.keys('refresh:{userId}:*')` + delete lets you implement "logout from all devices" by wiping every session for a user.

---

### "What is SERIALIZABLE isolation and when do you need it?"

**Phase**: 5

Database transactions run at different isolation levels that trade correctness for performance. The weakest (READ COMMITTED, the PostgreSQL default) allows phenomena like:

- **Non-repeatable reads**: read the same row twice in one transaction, get different values
- **Phantom reads**: a query returns different rows if run twice (another transaction inserted/deleted rows between reads)

For money transfers, these matter. Consider: two concurrent transfers both reading `balance = 1000` before either has committed. Both calculate they have enough funds. Both proceed. Both subtract $800. The final balance is -$600. This is a **lost update** — neither transaction saw the other's write.

SERIALIZABLE isolation guarantees that concurrent transactions execute as if they ran one after the other. Any non-serializable outcome causes one of them to fail with error code `40001` (serialization failure). The project wraps the entire transfer in a retry loop (`withSerializableRetry`) that retries up to 3 times on `40001`. This turns a correctness problem into a latency problem — the operation may take a few extra milliseconds to retry, but it will always produce a correct result.

---

### "How do you prevent deadlocks in concurrent database operations?"

**Phase**: 5

A deadlock occurs when two transactions each hold a lock the other needs. Classic example:

- Transaction A locks account-1, waits for account-2
- Transaction B locks account-2, waits for account-1
- Neither can proceed

The project prevents this with **sorted lock acquisition**: before the transfer executes, both account IDs are sorted alphabetically and locked in that consistent order:

```sql
SELECT FROM accounts WHERE id IN (firstId, secondId) ORDER BY id FOR UPDATE
```

The `ORDER BY id` ensures transaction A and transaction B always try to lock account-1 before account-2, regardless of which is the source and which is the destination. With consistent ordering, circular waits are structurally impossible.

This is done inside the SERIALIZABLE transaction after `SET TRANSACTION ISOLATION LEVEL SERIALIZABLE`. The locks are acquired on freshly-read rows, not the pre-transaction fetch — this matters because pre-transaction fetched balances could be stale by the time locks are acquired.

---

### "What are PostgreSQL window functions and when would you use one?"

**Phase**: 7

A window function computes a value for each row using a "window" of related rows — without collapsing them into a group (unlike `GROUP BY`). Each row retains its own identity in the result while also having access to an aggregation over nearby rows.

The ledger endpoint uses:

```sql
SUM(CASE WHEN le.type = 'credit' THEN le.amount ELSE -le.amount END)
  OVER (ORDER BY le.created_at ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW)
  AS running_balance
```

For each row, this computes the cumulative net balance from the oldest visible row up to and including the current row. The result set is ordered newest-first (for display), but the window aggregation runs chronologically — so `running_balance` on each row represents the account balance at that point in time.

Without window functions, you'd need a subquery for each row (`SELECT SUM(...) FROM ledger_entries WHERE created_at <= le.created_at`) — O(n²) complexity. The window function computes it in a single pass.

The `FILTER` clause in the summary endpoint is a related feature:

```sql
SUM(amount) FILTER (WHERE type = 'credit') AS total_credits,
SUM(amount) FILTER (WHERE type = 'debit')  AS total_debits
```

This computes two conditional sums in one pass instead of two subqueries or two CASE expressions.

---

### "What is cursor pagination and why is it better than offset for large datasets?"

**Phase**: 7

Offset pagination (`LIMIT 50 OFFSET 1000`) tells the database to skip 1,000 rows and return the next 50. The problem: to skip 1,000 rows, PostgreSQL must still read and count them — you pay the I/O cost of 1,000 rows even though you discard them. At offset 100,000, this becomes noticeably slow.

Cursor pagination replaces the offset with a condition on an indexed column:

```sql
WHERE account_id = ? AND created_at < ? ORDER BY created_at DESC LIMIT 50
```

The `before` cursor (an encoded timestamp from the last row of the previous page) is used as the `<` bound. The index on `(account_id, created_at DESC)` means the query starts exactly where the cursor points — no skipping, no counting.

The cursor is base64url-encoded so clients treat it as an opaque token — they can't manually increment it or guess the next cursor. On the response, `nextCursor` is only included if the page is full (`results.length === limit`), signaling there are more pages.

The trade-off: cursor pagination can't jump to an arbitrary page ("go to page 47"). It's sequential. For ledger history — which is naturally consumed page-by-page — this is fine.

---

### "What is rate limiting and how do you implement it with Redis?"

**Phase**: 8

Rate limiting caps how many operations a user can perform in a time window. The project limits transfers to 20 per 10-minute window per user, implemented with a Redis fixed-window counter.

```
INCR ratelimit:transfer:{userId}
  → if result === 1: EXPIRE ratelimit:transfer:{userId} 600
  → if result > 20: throw 429 TooManyRequestsError
```

The key design decisions:

- **INCR before check**: The counter increments even for rejected or failed transfers. This prevents a user from hammering the pre-check without committing transfers and evading the limit.
- **EXPIRE only on count === 1**: The TTL is set on the first request. Subsequent increments leave the existing TTL intact. If you re-set the TTL on every request, the window never expires as long as requests keep coming.
- **Pre-transaction placement**: The velocity check runs before the SERIALIZABLE transaction opens. It's fast (Redis round-trip), and failing it early avoids the overhead of acquiring database locks.

Fixed-window has a known limitation: a user can make 20 requests at 9:59 and 20 more at 10:01 — 40 in 2 seconds. Sliding-window (using Redis sorted sets) solves this but is more complex. For a transfer rate limiter, the fixed-window burst is an acceptable trade-off.

---

## Senior

---

### "Walk me through designing a financially correct money transfer."

**Phase**: 5

A correct transfer must satisfy: atomicity (all steps succeed or none do), isolation (concurrent transfers don't interfere), and auditability (every balance state is recorded). Here's how each is achieved:

**Atomicity**: All writes happen inside a single SERIALIZABLE PostgreSQL transaction — balance updates on both accounts, both ledger entries, the transfer record, and the outbox event. If anything fails, the entire transaction rolls back. No partial state is possible.

**Isolation**: SERIALIZABLE prevents concurrent balance-read exploits. Combined with sorted lock acquisition (`ORDER BY id FOR UPDATE`), deadlocks are structurally impossible. A serialization failure retries up to 3 times automatically.

**Validation order inside the transaction**:
1. Idempotency check (return early if already processed)
2. Lock both accounts in sorted order (fresh, locked rows)
3. Validate statuses on locked rows (pre-transaction fetch could be stale)
4. Check sufficient funds using `Decimal` arithmetic
5. Check daily limit against live ledger sum
6. Update balances (`version++` for optimistic lock audit trail)
7. Insert transfer record
8. Insert both ledger entries with `balance_after`
9. Insert outbox event

Step 3 using **locked rows** is important: if you validate status from the pre-transaction fetch, another transaction could freeze the account between the fetch and the lock acquisition. Validating on the locked, fresh row closes that race.

**Auditability**: `balance_after` on every ledger entry captures the exact account balance at each point in time. Reconstructing any historical balance requires no replay — just look up the ledger entry for that moment.

---

### "How do you implement fraud signal scoring in a way that doesn't block user response?"

**Phase**: 8

Fraud detection has two requirements that tension against each other: it needs real-time data (the current transfer amount, recent velocity) but must not slow down the user's transfer response.

The project splits checks by when they run and how they block:

| Check | Where | Blocks user? | Why |
|-------|-------|-------------|-----|
| Transfer velocity (Redis INCR) | Pre-transaction | Yes | Fast (Redis), prevents overload |
| Daily volume (SQL SUM) | Inside transaction | Yes | Must be exact and atomic — inside locked rows |
| Fraud signal scoring | Post-transaction (outbox) | No | Can use enriched data, network calls |

The fraud signal is computed and written to MongoDB by the outbox handler, asynchronously. The user's `/transfers` response returns before the signal exists. Signals assess:

- **Velocity**: Redis counter at time of transfer (> 5 in window → suspicious)
- **Large amount**: percentage of daily limit (≥ 80% → high severity)
- **New recipient**: query if this user has sent to this account before (`priorCount <= 1`)

Each signal has a severity (low/medium/high) with weights (10/25/40). The risk score is the sum of signal weights, capped at 100. Score ≥ 70 → block (flag for review), ≥ 30 → review, else → allow.

The signal is written with `$setOnInsert` upsert — if the outbox handler runs twice (crash recovery), the second run finds an existing document and does nothing.

---

### "How do you design an immutable audit trail?"

**Phase**: 2

An audit trail is only valuable if it can't be tampered with after the fact. The project enforces immutability on `AuditEvent` MongoDB documents at the model layer — not by convention, but by throwing errors on any write operation:

```javascript
// 6 pre-hooks on AuditEvent:
pre('save')            → throw "AuditEvent is immutable"
pre('deleteOne')       → throw "AuditEvent is immutable"
pre('deleteMany')      → throw "AuditEvent is immutable"
pre('findOneAndUpdate') → throw "AuditEvent is immutable"
pre('updateOne')       → throw "AuditEvent is immutable"
pre('updateMany')      → throw "AuditEvent is immutable"
```

Documents can only be created, never modified or deleted. The `updatedAt` timestamp is also omitted from the schema (`timestamps: { createdAt: true, updatedAt: false }`) — there's no concept of "last updated" on an immutable record.

Each event stores a full `payload` snapshot (Mixed type) at write time — the complete state of the entity at the moment the event occurred. This means the audit log is self-contained; even if the primary record changes, the audit event reflects what was true when it was written.

The outbox handler writes audit events with `$setOnInsert` upsert (keyed on event type + target + transfer ID) so crash-recovery reruns don't create duplicate audit entries.

---

### "How do you design a reconciliation system for a financial ledger?"

**Phase**: 9

Reconciliation verifies that the system's stored state matches what it should be according to its own invariants. It doesn't fix problems — it detects and alerts on them for human investigation.

The system checks two invariants:

**Global net**: The sum of all ledger entries (credits minus debits) must be exactly zero. Any non-zero result means a transfer was written incompletely or a compensating entry is missing.

```sql
SELECT COALESCE(SUM(CASE WHEN type='credit' THEN amount ELSE -amount END), 0) AS net
FROM ledger_entries
```

This is a full table scan — intentional. There's no predicate that would make an index useful here; the aggregate must cover every row.

**Per-account balance**: Each account's stored `balance` column must equal the sum of its ledger entries.

```sql
SELECT a.id, a.balance, COALESCE(SUM(CASE WHEN l.type='credit' THEN l.amount ELSE -l.amount END), 0) AS computed
FROM accounts a
LEFT JOIN ledger_entries l ON l.account_id = a.id
GROUP BY a.id, a.balance
HAVING a.balance != COALESCE(SUM(...), 0)
```

The `LEFT JOIN` is critical: accounts with zero balance and no ledger entries must still be checked (they're correct), and they'd be excluded by an `INNER JOIN`. The `HAVING` clause filters to only discrepancies — accounts where stored ≠ computed.

When a discrepancy is found, it's logged as `logger.fatal` (highest severity) and written to MongoDB as a `RECONCILIATION_FAILURE` audit event. The audit event uses `$setOnInsert` keyed on `(eventType, accountId, date)` — one alert per account per day, not one per reconciliation tick.

The job has an `isRunning` guard: if a reconciliation is still running when the next tick fires (slow query on large dataset), the new tick logs a warning and skips. This prevents concurrent reconciliations from producing duplicate alerts.

---

### "How do you handle role-based access control without embedding roles in JWT?"

**Phase**: 8

The typical shortcut is embedding `role: 'admin'` in the JWT payload — no extra database lookup required. But this has a significant flaw: if a user's role changes (promoted, demoted, revoked), the change doesn't take effect until their token expires and they log in again. An admin whose access should be revoked remains an admin for up to 15 minutes.

The project looks up the role from PostgreSQL on every admin request:

```javascript
const user = await db('users').where({ id: req.user.sub }).first('role');
if (user.role !== 'admin') throw new ForbiddenError();
```

This adds one query per admin request, but admin endpoints are called rarely. The benefit: role changes take effect on the very next request. No "logout all sessions and re-login" required.

This also keeps the JWT payload minimal — just `{ sub: userId }` — which reduces token size and avoids the question of JWT claims becoming stale.

---

## Architecture / Staff

---

### "How do you choose between PostgreSQL and MongoDB for different parts of the same system?"

**Phases**: 1, 2, 6

The project uses both, deliberately, based on data access patterns and consistency requirements:

**PostgreSQL** (accounts, transfers, ledger):
- Needs ACID transactions — a transfer that updates two balances and writes two ledger entries must be atomic
- Needs SERIALIZABLE isolation — concurrent transfers touching the same account must be serializable
- Schema is stable and well-defined — no need for document flexibility
- Relationships matter (foreign keys enforce referential integrity)
- Financial correctness requires exact DECIMAL, constraints, and reconciliation

**MongoDB** (receipts, audit events, fraud signals):
- Write-once, read-many — receipts and audit events are never updated
- Schema varies per event type — fraud signal details differ by signal kind (`Mixed` type handles this without migrations)
- Denormalized at write time — display names and account numbers embedded in receipt eliminate cross-database joins on read
- Eventual consistency acceptable — receipt appears within seconds of transfer, not in the same request
- High write throughput for audit events — MongoDB handles large append-only collections efficiently

The Outbox pattern bridges the two: PostgreSQL is the authoritative source, MongoDB is a derived view written asynchronously. If MongoDB goes down, no transfers are lost — they accumulate in the outbox and drain when MongoDB recovers.

---

### "Walk me through the full consistency model of this system."

**Phases**: 5, 6, 9

**Strong consistency** (PostgreSQL, inside SERIALIZABLE transaction):
- Balance updates, ledger entries, and transfer records are written atomically
- Any concurrent transfer that conflicts fails with `40001` and retries
- Daily limit check runs inside the transaction with row locks held — no race window

**Eventual consistency** (PostgreSQL → MongoDB, via Outbox):
- Receipts, audit events, and fraud signals appear within ~5 seconds of a transfer
- The outbox poller uses `FOR UPDATE SKIP LOCKED` so multiple instances don't duplicate writes
- MongoDB writes use `$setOnInsert` upsert — idempotent, crash-safe
- If MongoDB is unavailable, outbox events accumulate and drain on recovery

**Periodic verification** (Reconciliation job, daily):
- Checks that stored balances match ledger sums
- Checks that global net is zero
- Reports discrepancies without auto-correcting — human investigation is required for financial data

The system makes a deliberate trade: MongoDB consistency is sacrificed for write throughput and schema flexibility, PostgreSQL consistency is never sacrificed. The reconciliation job acts as a long-running integrity check that catches anything that slips through.

---

### "How would you scale this system?"

**Phases**: 3–8

Each component scales differently:

- **API servers**: Stateless (JWT auth, Redis for session state). Scale horizontally behind a load balancer. Rate limit counters are shared in Redis across all instances.

- **PostgreSQL**: The bottleneck. SERIALIZABLE transactions on hot accounts limit parallelism — two concurrent transfers on the same account serialize. Vertical scaling (more RAM for buffer pool) buys the most. Read replicas handle ledger queries and reconciliation. For extreme scale, shard by user ID (each shard handles a subset of accounts, transfers only cross shards for inter-user transfers).

- **MongoDB**: Horizontal scaling via sharding. Shard key on `transferId` (receipts/fraud signals) or `targetId` (audit events) distributes writes evenly. Replica sets for read scaling.

- **Redis**: Cluster mode for rate limit counters and balance cache. Balance cache keys are `balance:{accountId}` — naturally distributed across cluster slots.

- **Outbox poller**: Multiple instances use `FOR UPDATE SKIP LOCKED` to distribute work. Scale by adding instances; PostgreSQL locks prevent double-processing.

The fundamental bottleneck for a financial system at scale is the SERIALIZABLE transaction on hot accounts. Common mitigations: optimistic concurrency (version field already present), account sharding, or event sourcing (append-only, no row lock contention). The `version` column on `accounts` is already in the schema — a foundation for optimistic locking if row-level contention becomes a problem.

---

### "How would you design a 'logout from all devices' feature?"

**Phase**: 3

The project's refresh token storage in Redis makes this straightforward. Each refresh token is stored with key `refresh:{userId}:{tokenId}`. To log out from all devices for a user:

```javascript
const keys = await redis.keys(`refresh:${userId}:*`);
if (keys.length > 0) await redis.del(...keys);
```

This invalidates every active session for the user instantly. The next time any of their devices tries to use a refresh token, Redis returns no match and the refresh fails — forcing re-login.

Access tokens (15-minute TTL) can't be revoked this way — they're stateless JWTs. The short TTL is the mitigation: even if an access token is stolen, it's unusable within 15 minutes. If immediate access token invalidation were required, you'd need a token blocklist in Redis (a set of revoked `jti` values checked on every request) — but that adds a Redis round-trip to every authenticated request.

---

### "Why does the reconciliation job report discrepancies instead of auto-correcting them?"

**Phase**: 9

Auto-correction in a financial system is dangerous: if the reconciliation logic has a bug, it could "correct" valid data into an incorrect state. A corrupted balance silently fixed is worse than a corrupted balance that's flagged — at least the flagged one triggers human investigation.

Financial systems treat data integrity issues as incidents, not bugs to be silently patched. The correct response is:

1. Alert immediately (logger.fatal, audit event in MongoDB)
2. Investigate the root cause (which transfer created the discrepancy? was there a hardware failure? a bug in the transfer logic?)
3. Write a compensating entry manually after understanding what actually happened

Auto-correction assumes you know which side is wrong — stored balance or ledger sum. You don't. A bug in the balance update could mean the stored balance is wrong; a bug in ledger entry creation could mean the ledger sum is wrong. Only human investigation can determine which.

The audit event upsert (`$setOnInsert` keyed on date + account) ensures operations teams get one alert per account per day — enough to notice the problem without being spammed on every reconciliation tick.
