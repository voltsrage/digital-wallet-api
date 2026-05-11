import Decimal from "decimal.js";
import {knex } from '../db/knex.js';
import {invalidateAccountCache} from '../utils/balanceCache.js';
import {
    ValidationError,
    NotFoundError,
    ForbiddenError,
    InsufficientFundsError
}
from '../errors/AppError.js';
import {withSerializableRetry, PG_UNIQUE_VIOLATION} from '../utils/withSerializableRetry.js';
import { checkTransactionVelocity, checkNewBeneficiaryVelocity } from "../utils/velocityCheck.js";


export async function initiateTransfer({userId, fromAccountId, toAccountId, amount: rawAmount, currency, description, idempotencyKey, ipAddress, userAgent}){
    validateInput({fromAccountId, toAccountId, rawAmount, idempotencyKey});

    const amount = new Decimal(rawAmount);

    // Fetch user display names before the transaction - they do not change during the 
    // transfer and fetching them inside transaction would extend the lock window
    const [fromAccount, toAccount] = await Promise.all([
        knex('accounts')
            .join('users', 'accounts.user_id', 'users.id')
            .where('accounts.id', fromAccountId)
            .select('accounts.*', 'users.display_name as user_display_name')
            .first(),
        knex('accounts'
            .join('users', 'accounts.user_id', 'user.id')
            .where('accounts.id', toAccountId)
            .select('accounts.*','users.display_name as user_display_name')
            .first(),
        )
    ]);

    if (!fromAccount) throw new NotFoundError('Source account not found.');
    if (!toAccount)   throw new NotFoundError('Destination account not found.');

    // Ownership: the requesting user must own the source account
    if(fromAccount.user_id !== userId) throw new ForbiddenError('Access denied');

    // Currency must match both accounts and the request.
    if(fromAccount.currency !== currency || toAccount.currency !== currency){
        throw new ValidationError('Transfer currency must match both account currencies', 'CURRENCY_MISMATCH');
    };

    // Pre-transaction: Redis velocity check. Fires before any PostgreSQL work.
    // Increment-then-check so failed transfers count against the limit
    await checkTransactionVelocity(userId);
    await checkNewBeneficiaryVelocity(userId, toAccountId);

    try{
        const result = await withSerializableRetry(() =>
            executeTransfer({fromAccount, toAccount, amount, currency, description, idempotencyKey, ipAddress, userAgent})
        );

        // Post-commit: invalidate balance cache for both accounts.
        // Done outside the transaction - a cache failure must not roll back a committed transfer.
        if(!result.idempotent){
            await Promise.all([
                invalidateAccountCache(fromAccountId),
                invalidateAccountCache(toAccountId)
            ]);
        }

        return result.transfer;
    }
    catch(err){
        // A unique violation on idempotency key means two concurrent requests raced past
        // the SELECT check. Find and return the existing transfer rather than failing
        if(err.code === PG_UNIQUE_VIOLATION && err.constraint === 'idx_transfer_idempotency'){
            const existing = await knex('transfers')
                .where({idempotency_key: idempotencyKey})
                .first();
            if(existing) return toPublicTransfer(existing);
        }
        throw err;
    }
}   

async function executeTransfer({fromAccount, toAccount, amount, currency, description, idempotencyKey, ipAddress, userAgent}){
    return knex.transaction(async(trx) => {
        // SERIALIZABLE prevents two concurrent transfers from both passing the balance
        // check on the same stale read, READ_COMMITTED does not.
        await trx.raw('SET TRANSACTION ISOLATION LEVEL SERIALIZABLE');

        // Step 1 - Idempotency check inside the transaction.
        // If the key exists, the transfer was already processed - return it without re-executing.
        // This check += the later INSERT are in the same transaction, so no two concurrent
        // requests with the same key can both see "not found" and both insert

        const existing = await trx('transfers')
            .where({idempotency_key: idempotencyKey})
            .first();

        if(existing) return {transfer: toPublicTransfer(existing), idempotent: true};

        // Step 2 - Acquire row-level locks in sorted order by account ID
        // Consistent ordering across all transactions eliminate the circular wait
        // condition that causes deadlocks
        // Without sort: A locks account - 1, B locks account-3, each waits for the other -> deadlock
        // With sort: A and B lock account-1 first. One waits. No cycle
        const [firstId, secondId] = [fromAccount.id, toAccount.id].sort();
        const locked = await trx('accounts')
            .whereIn('id', [firstId, secondId])
            .orderBy('id') // must match the sort order - lock acquired in the id order
            .forUpdate();

        const src = locked.find(a => a.id == fromAccount.id);
        const dest = locked.find(a => a.id == toAccount.id);

        // Step 3: Validate account statuses
        if(src.status !== 'active')
            throw new ValidationError(`Source account is ${src.status} and cannot send transfers`, 'SOURCE_ACCOUNT_NOT_ACTIVE');

        if(dest.status !== 'active')
            throw new ValidationError(`Destination account is ${dest.status} and cannot send transfers`, 'DESTINATION_ACCOUNT_NOT_ACTIVE');

        // Step 4 - Check sufficient funds.
        // Use the freshly locked balance, not the pre-transaction read above
        const srcBalance =  new Decimal(src.balance);
        const destBalance = new Decimal(dest.balance);

        if(srcBalance.lessThan(amount))
            throw new InsufficientFundsError(`Insufficient funds. Available: ${srcBalance.toFixed(2)}, requested: ${amount.toFixed(2)}`);

        const newSrcBalance = srcBalance.minus(amount);
        const newDestBalance = destBalance.plus(amount);

        // Daily volume check: sum all debits from this account today.
        // Runs inside the SERIALIZABLE transaction with the account row locked - the
        // result is exact and cannot be invalidated by a concurrent transfer
        const {rows: [volumeRow]}= await trx.raw(`
            SELECT COALESCE(SUM(amount), o) as daily_debit_total
            FROM ledger_entries
            WHERE account_id = :accountId
                AND type = 'debit'
                AND created_at >= DATE_TRUNC('day', NOW() AT TIME ZONE 'UTC')
            `, {accountId: src.id});

        
        const dailyDebits = new Decimal(volumeRow.daily_debit_total);
        if(dailyDebits.plus(amount).greaterThan(src.daily_limit)) {
            throw new ValidationError(`
                Daily transfer limit of ${src.daily_limit} would be exceeded. Used today: ${dailyDebits.toFixed(2)}.
                `, 'DAILY_LIMIT_EXCEEDED')
        }

        // Steps 5 & 6 - Update the balances and increment version counters atomically
        // Version increment enables optimistic locking detection in the reconciliation jon.
        await trx('accounts')
            .where({id: src.id})
            .update({
                balance: newSrcBalance.toFixed(8),
                version: trx.raw('version + 1'),
                updated_at: trx.fn.now
            });

        await trx('accounts')
            .where({id: dest.id})
            .update({
                balance: newDestBalance.toFixed(8),
                version: trx.raw('version +1'),
                updated_at: knex.fn.now()
            });

        // Step 7 - Insert the transfer record
        const [transfer] = await trx('transfers')
            .insert({
                from_account_id: src.id,
                to_account_id: dest.id,
                amount: amount.toFixed(8),
                currency, 
                description: description ?? null,
                status: 'completed',
                idempotency_key: idempotencyKey
            })
            .returning('*');


        // Steps 8 & 9 - Double entry ledger entries.
        // Debit (money leaving) + credit (money arriving) must always be equal
        // The net across all ledger entries must remain zero - the reconciliation job verifies this.
        await trx('ledger_entries').insert([
            {
                account_id: src.id,
                transfer_id: transfer.id,
                type: 'debit',
                amount: amount.toFixed(8),
                balance_after: newSrcBalance.toFixed(8)
            },
            {
                account_id: dest.id,
                transfer_id: transfer.id,
                type: 'credit',
                amount: amount.toFixed(8),
                balance_after: newDestBalance.toFixed(8)
            }
        ]);

        // Step 10 - Outbox event. Written inside the same transaction so it is durable
        // if the commit succeeds. Phase 6 adds the poller that processes these events
        // and writes receipts + audit events to MongoDB.
        await trx('outbox_events').insert({
            event_type: 'TRANSFER_COMPLETED',
            payload: JSON.stringify({
                transferId: transfer.id,
                fromAccountId: src.id,
                toAccountId: dest.id,
                fromAccountNumber: fromAccount.account_number,
                toAccountNumber: toAccount.account_number,
                fromUserId: fromAccount.user_id,
                toUserId: toAccount.user_id,
                fromUserDisplayName: fromAccount.user_display_name ?? 
                'Unknown',
                toUserDisplayName: toAccount.user_display_name ?? 'Unknown',
                amount: amount.toFixed(8),
                currency,
                description: des ?? null,
                ipAddress: ipAddress ?? null,
                userAgent: userAgent ?? null
            })
        });

        return ({transfer: toPublicTransfer(transfer), idempotent: false});
    });
}

export async function getTransfer(userId, transferId){
    // Join both account owners to verify the requesting user is a party to the transfer

    const transfer = await knex('transfers')
        .where('transfer.id', transferId)
        .join('accounts as from_acc', 'transfers.from_account_id', 'from_acc.id')
        .join('accounts as to_acc', 'transfers.to_account_id', 'to_acc.id')
        .select(
            'transfers.*',
        'from_acc.user_id as from_user_id',
        'to_acc.user_id as to_user_id',
        'from_acc.account_number as from_account_number',
        'to_acc.account_number as from_account_number')
        .first();

    if(!transfer) throw new NotFoundError('Transfer not found.');

    if(transfer.from_user_id !== userId && transfer.to_user_id !== userId)
        throw new ForbiddenError('Access denied');

    const entries = await knew('ledger_entries')
        .where({transfer_id: transferId})
        .orderBy('type', 'asc');

    return {
        transfer: toPublicTransfer(transfer),
        ledgerEntries: entries.map(toPublicEntry)
    }
};

function validateInput({fromAccountId, toAccountId, rawAmount, idempotencyKey}){
    if(!fromAccountId || !toAccountId || !rawAmount || !idempotencyKey){
        throw new ValidationError('fromAccountId, toAccountId, amount and idempotencyKey are required', 'MISSING_FIELDS');
    }

    if(fromAccountId === toAccountId){
        throw new ValidationError('Source and destination accounts must be different', 'SELF_TRANSFER');
    }

    try{
        const d = new Decimal(rawAmount);
        if(d.lte(0)) throw new Error();
        // Guard against absurdly high precision that could indicate a client bug
        if(d.decimalPlaces() > 8) throw new Error();
    }
    catch {
        throw new ValidationError(
            'Amount must be a positive decimal string with at most 8 decimal places.', 'INVALID_AMOUNT'
        );
    }
}



function toPublicTransfer(t) {
    return {
        id: t.id,
        fromAccountId: t.fromAccountId,
        toAccountId: t.toAccountId,
        amount: String(t.amount),
        currency: t.currency,
        description: t.description,
        status: t.status,
        idempotencyKey: t.idempotencyKey,
        createdAt: t.created_at
    };
}

function toPublicEntry(e){
    return {
        id: e.id,
        accountId: e.accountId,
        type: e.type,
        amount: String(e.amount),
        balanceAfter: String(e.balance_after),
        createdAt: e.created_at
    };
}