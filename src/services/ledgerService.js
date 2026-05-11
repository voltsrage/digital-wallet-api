import {knex} from '../db/knex.js';
import {
    NotFoundError,
    ForbiddenError,
    ValidationError
}
from '../errors/AppError.js';

export async function getLedger(userId, accountId, {before, limit = '50'}){
    await assertAccountOwnership(accountId, userId);

    const parsedLimit = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 100);

    // Decode the opaque cursor back into an ISO timestamp
    // If not cursor is provided, start from now - returns the most recent entries
    const cursorDate = before
        ? new Date(Buffer.from(before, 'base64url').toString('utf8'))
        : new Date();

    if (before && isNaN(cursorDate.getTime())) {
        throw new ValidationError('Invalid cursor', 'INVALID_CURSOR');
    }

    // The window function computes a cumulative running balance ordered chronologically
    // over the filtered result set. Important: this matches balance_after exactly only
    // when querying without a cursor (full history). With a cursor balance after is always
    // the authoritative stored balance; running_balance is analytical

    const {rows} = await knex.raw(`
        SELECT
            le.id,
            le.account_id,
            le.transfer_id,
            le.type,
            le.amount::text AS amount,
            le.balance_after::text AS balance_after,
            le.created_at,
            t.description,
            SUM(CASE WHEN le.type = 'credit' THEN le.amount ELSE -le.amount END)
                OVER (ORDER BY le.created_at ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW)
                as running_balance
        FROM ledger_entries le
        JOIN transfers t on t.id = le.transfer_id
        WHERE le.account_id = :accountId
            AND le.created_at < :cursorDate
        ORDER BY le.created_at DESC
        LIMIT :limit
        `, {accountId, cursorDate, limit: parsedLimit});

    // If the page is full, there may be more entries. Encode the oldest returned
    // entry's timestamp as the next cursor
    let nextCursor = null;
    if(rows.length === parsedLimit){
        const oldest = rows[rows.length - 1];
        nextCursor = Buffer.from(oldest.created_at.toISOString()).toString('base64url');
    }

    return {
        entries: rows.map(toPublicEntry),
        nextCursor,
        hasMore: nextCursor != null
    };
}

export async function getAccountSummary(userId, accountId, {from, to}){
    await assertAccountOwnership(accountId, userId );

    // Default to the last 30 days when no range is specified
    const toDate = to ? new Date(to) : new Date();
    const fromDate = from ? new Date(from) : new Date(toDate - 30*24*60*60*1000);

    if(isNaN(fromDate.getTime()) || isNaN(toDate.getTime())) {
        throw new ValidationError('Invalid date range. Use ISO 8601 format.', 'INVALID_DATE_RANGE');
    }

    if(fromDate >= toDate)
        throw new ValidationError('from must be before to.', 'INVALID_DATE_RANGE');

    // DATE_TRUNC('day', created_at) groups all entries for a calendar into one row.
    // FILTER (WHERE type = 'credit') applies the WHERE condition only to that aggregate -
    // this computes debits and credits in a single pass without a subquery or CASE
    const {rows} = await knex.raw(`
        SELECT
            DATE_TRUNC('day', created_at) AS day,
            COUNT(*)::int AS entry_count,
            COALESCE(SUM(amount) FILTER (WHERE type = 'credit'), 0) AS total_credits,
            COALESCE(SUM(amount) FILTER (WHERE type = 'debit'), 0) as total_debits,
            SUM(CASE WHEN type = 'credit' THEN amount ELSE -amount END) as net
        FROM ledger_entries
        WHERE account_id = :accountId
            AND created_at >= :fromDate
            AND created_at < :toDate
        GROUP BY DATE_TRUNC('day', created_at)
        ORDER BY day DESC
        `, {accountId, fromDate, toDate});

    return{
        accountId,
        from: fromDate,
        to: toDate,
        totals: computeTotals(rows),
        days: rows.map(toPublicDay)
    }
}

// Helpers
async function assertAccountOwnership(accountId, userId){
    const account = await knex('accounts')
        .where({id: accountId})
        .first();

    if(!account) throw new NotFoundError('Account not found');
    if(account.user_id !== userId) throw new ForbiddenError('Access denied');
    return account;
}

// Aggregate across all days in the response - useful for the client to display
// period totals without summing client side
function computeTotals(rows){
    let credits = 0n;
    let debits = 0n;
    for(const row of rows){
        credits += BigInt(Math.round(parseFloat(row.total_credits) * 1e8));
        debits += BigInt(Math.round(parseFloat(row.total_debits) * 1e8));
    }
    const fmt = (n) => (Number(n) / 1e8).toFixed(8);
    return {
        totalCredits: fmt(credits),
        totalDebits: fmt(debits),
        net: fmt(credits - debits)
    }
}

function toPublicEntry(e){
    return {
        id: e.id,
        accountId: e.account_id,
        transferId: e.transfer_id,
        type: e.type,
        amount: String(e.amount),
        balanceAfter: String(e.balance_after),
        runningBalance: String(e.running_balance),
        description: e.description ?? null,
        createdAt: e.created_at
    }
}

function toPublicDay(r){
    return{
        day: r.day,
        entryCount: r.entry_count,
        totalCredits: String(r.total_credits),
        totalDebits: String(r.total_debits),
        net: String(r.net)
    }
}
