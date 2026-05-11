import Decimal  from "decimal.js";
import {knex} from '../db/knex.js';
import {AuditEvent} from '../models/AuditEvent.js';
import {logger} from '../utils/logger.js';

export async function runReconciliation(){
    logger.info('Reconciliation job started');
    const startedAt = new Date();

    const [globalResult, accountResult] = await Promise.all([
        checkGlobalLedgerNet(),
        checkAccountBalances()
    ]);

    const durationMs = Date.now() - startedAt.getTime();
    const clean = globalResult.balanced && accountResult.discrepancies.length === 0;

    if(clean)
    {
        logger.info({durationMs}, 'Reconciliation complete - ledger balanced');
        return;
    }

    // One or both checks found a problem. Report each separately
    if(!globalResult.balanced){
        await reportGlobalImbalance(globalResult);
    }

    for(const discrepancy of accountResult.discrepancies){
        await reportAccountDiscrepancy(discrepancy);
    }

    logger.info({durationMs, globalBalanced: globalResult.balanced, accountDiscrepancies: accountResult.discrepancies.length},
        'Reconciliation complete - discrepancies found and reported'
    )
}

async function checkGlobalLedgerNet() {
    const {rows: [row]} = await knex.raw(`
        SELECT
            COALESCE(SUM(CASE WHEN type = 'credit' THEN amount ELSE 0 END), 0) as total_credits,
            COALESCE(SUM(CASE WHEN type = 'debit' THEN amount ELSE 0 END), 0) as total_debits,
            COALESCE(SUM(CASE WHEN type = 'credit' THEN amount ELSE -amount END), 0) as net
        FROM ledger_entries
        `);

    const net = new Decimal(row.net);

    return{
        balanced: net.isZero(),
        totalCredits: String(row.total_credits),
        totalDebits: String(row.total_debits),
        net: net.toFixed(8)
    };
}

async function checkAccountBalances() {
    // LEFT JOIN so accounts with no ledger entries are included
    // COALESCE returns 0 for accounts with no entries - a new account with
    // and no entries correctly satisfies 0 == 0 and does not appear in results
    const {rows} = await knex.raw(`SELECT
            a.id as account_id,
            a.account_number,
            a.balance::text as stored_balance,
            COALESCE(
                SUM(CASE WHEN l.type = 'credit' THEN l.amount ELSE -l.amount END),
                0
            )::text as computed_balance
        FROM accounts a
        LEFT JOIN ledger_entries l on l.account_id = a.id
        GROUP BY a.id, a.account_number, a.balance
        HAVING a.balance != COALESCE(
            SUM(CASE WHEN l.type = 'credit' THEN l.amount ELSE -l.amount END), 0
        )
        `);
    
    const discrepancies = rows.map((r) => ({
        accountId: r.account_id,
        accountNumber: r.account_number,
        storedBalance: r.stored_balance,
        computedBalance: r.computed_balance,
        difference: new Decimal(r.stored_balance).minus(r.computed_balance).toFixed(8),
    }));

    return {discrepancies};
}

async function reportGlobalImbalance({totalCredits, totalDebits, net}){
    // CRITICAL in Pino maps to a log level that Seq surfaces as an alert
    // The structured fields allow Seq to build dashboards and trigger notifications,
    logger.fatal(
        {totalCredits, totalDebits, net, alert: 'GLOBAL_LEDGER_IMBALANCE'},
        'RECONCILIATION FAILURE: global ledger net is not zero - money has been created or destroyed'
    );

    // Audit event provides a durable, immutable record in MongoDB alongside
    // every other state change in the system
    await AuditEvent.updateOne(
        {
            eventType: 'GLOBAL_LEDGER_IMBALANCE',
            'payload.detectedAt': {$gte: startOfDay()}
        },
        {
            $setOnInsert: {
                eventType: 'GLOBAL_LEDGER_IMBALANCE',
                actorId: 'system',
                targetId: 'ledger',
                targetType: 'ledger',
                payload: {totalCredits, totalDebits, net, detectedAt: new Date()},
                createdAt: new Date()
            }
        },{
            upsert: true
        }
    )
}

async function reportAccountDiscrepancy({accountId, accountNumber, storedBalance, computedBalance, difference}){
    logger.fatal(
        {accountId, accountNumber, storedBalance, computedBalance, difference, alert: 'ACCOUNT_BALANCE_MISMATCH'},
        `RECONCILIATION FAILURE: account ${accountNumber} stored balance does not match ledger sum`
    );

    await AuditEvent.updateOne(
        {
            eventType: 'RECONCILIATION_FAILURE',
            'payload.accountId': accountId,
            'payload.detectedAt': {$gte: startOfDay()},
        },
        {
            $setOnInsert: {
                eventType: 'RECONCILIATION_FAILURE',
                actorId: 'system',
                targetId: accountId,
                targetType: 'account',
                payload: {accountId, accountNumber, storedBalance, computedBalance, difference, detectedAt: new Date()},
                createdAt: new Date(),
            },
        },
        {upsert: true},
    );
}

// Returns midnight UTC today - used to prevent duplicate audit events
// when the job runs more than once per day in development
function startOfDay() {
    const d = new Date();
    d.setUTCHours(0,0,0,0);
    return d;
}