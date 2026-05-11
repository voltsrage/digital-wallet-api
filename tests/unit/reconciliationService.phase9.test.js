import {describe, expect, it, jest, beforeEach} from '@jest/globals';

const auditUpdateOne = jest.fn().mockResolvedValue({});
const loggerInfo = jest.fn();
const loggerFatal = jest.fn();
const loggerError = jest.fn();
const loggerWarn = jest.fn();

jest.unstable_mockModule('../../src/models/AuditEvent.js', () => ({
    AuditEvent: {updateOne: auditUpdateOne},
}));

jest.unstable_mockModule('../../src/utils/logger.js', () => ({
    logger: {
        info: loggerInfo,
        fatal: loggerFatal,
        error: loggerError,
        warn: loggerWarn,
    },
}));

const knexRaw = jest.fn();

jest.unstable_mockModule('../../src/db/knex.js', () => ({
    knex: {raw: knexRaw},
}));

const {runReconciliation} = await import('../../src/services/reconciliationService.js');

function rawResultForSql(sql) {
    if (sql.includes('FROM accounts a')) {
        return {rows: []};
    }
    if (sql.includes('FROM ledger_entries') && sql.includes('as net')) {
        return {
            rows: [
                {
                    total_credits: '100.00',
                    total_debits: '100.00',
                    net: '0',
                },
            ],
        };
    }
    return {rows: []};
}

describe('runReconciliation', () => {
    beforeEach(() => {
        knexRaw.mockReset();
        auditUpdateOne.mockClear();
        loggerInfo.mockClear();
        loggerFatal.mockClear();
        loggerError.mockClear();
        loggerWarn.mockClear();
        knexRaw.mockImplementation((sql) => Promise.resolve(rawResultForSql(sql)));
    });

    it('logs success when global net is zero and no account mismatches', async () => {
        await runReconciliation();

        expect(loggerFatal).not.toHaveBeenCalled();
        expect(auditUpdateOne).not.toHaveBeenCalled();
        expect(loggerInfo).toHaveBeenCalledWith(
            {durationMs: expect.any(Number)},
            'Reconciliation complete - ledger balanced',
        );
    });

    it('reports global imbalance when credits and debits do not net to zero', async () => {
        knexRaw.mockImplementation((sql) => {
            if (sql.includes('FROM accounts a')) {
                return Promise.resolve({rows: []});
            }
            return Promise.resolve({
                rows: [
                    {
                        total_credits: '100.00',
                        total_debits: '90.00',
                        net: '10',
                    },
                ],
            });
        });

        await runReconciliation();

        expect(loggerFatal).toHaveBeenCalledWith(
            expect.objectContaining({alert: 'GLOBAL_LEDGER_IMBALANCE'}),
            expect.stringMatching(/global ledger net is not zero/i),
        );
        expect(auditUpdateOne).toHaveBeenCalledWith(
            expect.objectContaining({eventType: 'GLOBAL_LEDGER_IMBALANCE'}),
            expect.objectContaining({
                $setOnInsert: expect.objectContaining({
                    eventType: 'GLOBAL_LEDGER_IMBALANCE',
                    targetType: 'ledger',
                }),
            }),
            {upsert: true},
        );
        expect(loggerInfo).toHaveBeenCalledWith(
            expect.objectContaining({globalBalanced: false, accountDiscrepancies: 0}),
            expect.any(String),
        );
    });

    it('reports account-level discrepancies and writes RECONCILIATION_FAILURE audit', async () => {
        knexRaw.mockImplementation((sql) => {
            if (sql.includes('FROM accounts a')) {
                return Promise.resolve({
                    rows: [
                        {
                            account_id: 'acc-1',
                            account_number: 'ACC-999',
                            stored_balance: '50.00',
                            computed_balance: '40.00',
                        },
                    ],
                });
            }
            return Promise.resolve({
                rows: [{total_credits: '100', total_debits: '100', net: '0'}],
            });
        });

        await runReconciliation();

        expect(loggerFatal).toHaveBeenCalledWith(
            expect.objectContaining({alert: 'ACCOUNT_BALANCE_MISMATCH', accountNumber: 'ACC-999'}),
            expect.stringContaining('ACC-999'),
        );
        expect(auditUpdateOne).toHaveBeenCalledWith(
            expect.objectContaining({
                eventType: 'RECONCILIATION_FAILURE',
                'payload.accountId': 'acc-1',
            }),
            expect.objectContaining({
                $setOnInsert: expect.objectContaining({
                    targetId: 'acc-1',
                    targetType: 'account',
                }),
            }),
            {upsert: true},
        );
    });
});
