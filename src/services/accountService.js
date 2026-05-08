import Decimal from 'decimal.js';
import { knex } from '../db/knex.js';
import { AuditEvent } from '../models/AuditEvent.js';
import {
    NotFoundError,
    ValidationError,
    ForbiddenError
}
    from '../errors/AppError.js';
import {
    getCachedAccount,
    setCachedAccount,
    invalidateAccountCache
}
    from '../utils/balanceCache.js'

// State Machine: which transitions are legal from each status
const VALID_TRANSITIONS = {
    active: ['frozen', 'closed'],
    frozen: ['active', 'closed'],
    closed: [] // terminal — no transitions allowed
};

function assertTransition(current, next) {
    if (!VALID_TRANSITIONS[current]?.includes(next)) {
        throw new ValidationError(
            `Cannot transition account from '${current}' to '${next}'.`,
            'INVALID_STATUS_TRANSITION'
        );
    }
};

// Ownership check: every mutation verifies the account belongs to the requesting user.
async function assertOwnership(accountId, userId) {
    const account = await knex('accounts').where({ id: accountId }).first();
    if (!account) throw new NotFoundError('Account not found.');
    if (account.userId !== userId) throw new ForbiddenError('Access denied.');
    return account;
}

export async function createAccount(userId, { currency = 'USD' } = {}) {
    // Random 8-digit suffix — unique constraint is the safety net for the rare collision.
    const accountNumber = `ACC-${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`;

    const [account] = await knex('accounts')
        .insert({ user_id: userId, account_number: accountNumber, currency })
        .returning('*');

    await AuditEvent.create({
        eventType: 'ACCOUNT_CREATED',
        actorId: userId,
        targetId: account.id,
        targetType: 'account',
        payload: { accountNumber, currency },
    });

    return toPublicAccount(account);
}

export async function listAccounts(userId){
    const accounts = await knex('accounts')
        .where({user_id: userId})
        .orderBy('created_at', 'asc');

    return accounts.map(toPublicAccount);
}

export async function getAccount(userId, accountId){
    // Cache-aside: check Redis first. If status recently changed (freeze/close also
    // invalidate), the cache is stale and we re-read from PostgreSQL.
    const cached = await getCachedAccount(accountId);
    if(cached){
        if(cached.userId !== userId) throw new ForbiddenError('Access denied.');
        return cached;
    }

    const account = await assertOwnership(accountId, userId);

    const result = toPublicAccount(account);
    await setCachedAccount(accountId, result);
    return result;
}

export async function freezeAccount(userId, accountId){
    const account = await assertOwnership(accountId, userId);
    assertTransition(account.status, 'frozen');

    const [updated] = await knex('accounts')
        .where({id: accountId})
        .update({status: 'frozen', updated_at: knex.fn.now()})
        .returning('*');

    await invalidateAccountCache(accountId);

    await AuditEvent.create({
        eventType:  'ACCOUNT_FROZEN',
        actorId:    userId,
        targetId:   accountId,
        targetType: 'account',
        payload:    { previousStatus: 'active' },
    });

    return toPublicAccount(updated);
}

export async function unfreezeAccount(userId, accountId) {
    const account = await assertOwnership(accountId, userId);
    assertTransition(account.status, 'active');

    const [update] = await knex('accounts')
        .where({id: accountId})
        .update({status: 'active', updated_at: knex.fn.now()})
        .returning('*');
    
    await invalidateAccountCache(accountId);

    await AuditEvent.create({
        eventType:  'ACCOUNT_FROZEN',
        actorId:    userId,
        targetId:   accountId,
        targetType: 'account',
        payload:    { previousStatus: 'active' },
    });

    return toPublicAccount(updated);
}

export async function closeAccount(user, accountId){
    const account = await assertOwnership(accountId, userId);
    assertTransition(account.status, 'closed');

    // A non-zero balance means money would become unreachable — there is no owner
    // that could withdraw it. The account can only be closed when balance is exactly zero.

    /*
    ### Why `decimal.js` for the zero-check

    `account.balance` comes back from `pg` as a string (the `pg` driver returns `NUMERIC`/`DECIMAL` columns as strings to avoid 
    JavaScript float corruption). `new Decimal(account.balance).isZero()` handles `"0"`, `"0.00"`, `"0.00000000"` all correctly. 
    Comparing `account.balance === '0'` would fail for `'0.00000000'`.
    */
    if(!new Decimal(account.balance).isZero()){
        throw new ValidationError(
        'Account balance must be zero before closing.',
        'ACCOUNT_HAS_BALANCE'
        );
    }

    const [updated] = await knex('accounts')
        .where({id:accountId})
        .update({status: 'closed', updated_at: knex.fn.now()})
        .returning('*');

    await invalidateAccountCache(accountId);

    await AuditEvent.create({
        eventType:  'ACCOUNT_CLOSED',
        actorId:    userId,
        targetId:   accountId,
        targetType: 'account',
        payload:    { finalBalance: account.balance },
    });

    return toPublicAccount(updated);
}

function toPublicAccount(account) {
    return {
        id: account.id,
        userId: account.user_id,
        accountNumber: account.account_number,
        currency: account.currency,
        // Return balance as a string — never a JS Number — to prevent floating-point
        // representation before the value reaches the client.
        balance: String(account.balance),
        status: account.status,
        dailyLimit: String(account.daily_limit),
        createdAt: account.created_at,
        updatedAt: account.updated_at,
    };
}