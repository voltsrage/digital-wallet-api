import {describe, expect, it, jest, beforeEach} from '@jest/globals';

jest.unstable_mockModule('../../src/utils/velocityCheck.js', () => ({
    checkTransactionVelocity: jest.fn().mockResolvedValue(1),
    checkNewBeneficiaryVelocity: jest.fn().mockResolvedValue(undefined),
}));

jest.unstable_mockModule('../../src/utils/balanceCache.js', () => ({
    invalidateAccountCache: jest.fn().mockResolvedValue(undefined),
}));

const transferKnex = jest.fn();
transferKnex.fn = {now: jest.fn(() => '?')};
transferKnex.transaction = jest.fn();

jest.unstable_mockModule('../../src/db/knex.js', () => ({
    knex: transferKnex,
}));

const {initiateTransfer, getTransfer} = await import('../../src/services/transferService.js');
const {invalidateAccountCache} = await import('../../src/utils/balanceCache.js');
const {checkTransactionVelocity} = await import('../../src/utils/velocityCheck.js');

const fromId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const toId = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

const fromPrefetch = {
    id: fromId,
    user_id: 'owner-1',
    currency: 'USD',
    balance: '100.00',
    status: 'active',
    daily_limit: '10000',
    account_number: 'ACC-FROM',
    user_display_name: 'Alice',
};

const toPrefetch = {
    id: toId,
    user_id: 'owner-2',
    currency: 'USD',
    balance: '50.00',
    status: 'active',
    daily_limit: '10000',
    account_number: 'ACC-TO',
    user_display_name: 'Bob',
};

const baseTransferArgs = () => ({
    userId: 'owner-1',
    fromAccountId: fromId,
    toAccountId: toId,
    amount: '10.00',
    currency: 'USD',
    description: 'test',
    idempotencyKey: 'idem-key-1',
    ipAddress: '127.0.0.1',
    userAgent: 'jest',
});

function makeJoinFirstChain(row) {
    const c = {
        join: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        select: jest.fn().mockReturnThis(),
        first: jest.fn().mockResolvedValue(row),
    };
    return c;
}

beforeEach(() => {
    transferKnex.mockReset();
    transferKnex.transaction.mockReset();
    invalidateAccountCache.mockClear();
    checkTransactionVelocity.mockClear();
});

describe('initiateTransfer — validateInput', () => {
    it('throws MISSING_FIELDS when idempotencyKey is missing', async () => {
        const args = baseTransferArgs();
        delete args.idempotencyKey;
        await expect(initiateTransfer(args)).rejects.toMatchObject({code: 'MISSING_FIELDS'});
        expect(transferKnex).not.toHaveBeenCalled();
    });

    it('throws SELF_TRANSFER when accounts are identical', async () => {
        await expect(
            initiateTransfer({
                ...baseTransferArgs(),
                toAccountId: fromId,
            }),
        ).rejects.toMatchObject({code: 'SELF_TRANSFER'});
    });

    it('throws INVALID_AMOUNT for non-positive amount', async () => {
        await expect(
            initiateTransfer({...baseTransferArgs(), amount: '0'}),
        ).rejects.toMatchObject({code: 'INVALID_AMOUNT'});
    });

    it('throws INVALID_AMOUNT when more than 8 decimal places', async () => {
        await expect(
            initiateTransfer({...baseTransferArgs(), amount: '1.000000001'}),
        ).rejects.toMatchObject({code: 'INVALID_AMOUNT'});
    });
});

describe('initiateTransfer — pre-transaction checks', () => {
    beforeEach(() => {
        let accCalls = 0;
        transferKnex.mockImplementation((table) => {
            if (table !== 'accounts') {
                throw new Error(`Unexpected prefetch table: ${table}`);
            }
            accCalls += 1;
            if (accCalls === 1) {
                return makeJoinFirstChain(null);
            }
            return makeJoinFirstChain(toPrefetch);
        });
    });

    it('throws when source account is missing', async () => {
        await expect(initiateTransfer(baseTransferArgs())).rejects.toMatchObject({
            code: 'NOT_FOUND',
        });
    });

    it('throws when destination account is missing', async () => {
        let accCalls = 0;
        transferKnex.mockImplementation((table) => {
            if (table !== 'accounts') {
                throw new Error(table);
            }
            accCalls += 1;
            if (accCalls === 1) {
                return makeJoinFirstChain(fromPrefetch);
            }
            return makeJoinFirstChain(null);
        });
        await expect(initiateTransfer(baseTransferArgs())).rejects.toMatchObject({
            code: 'NOT_FOUND',
        });
    });

    it('throws ForbiddenError when user does not own the source account', async () => {
        transferKnex.mockImplementationOnce(() =>
            makeJoinFirstChain({...fromPrefetch, user_id: 'someone-else'}),
        );
        transferKnex.mockImplementationOnce(() => makeJoinFirstChain(toPrefetch));

        await expect(initiateTransfer(baseTransferArgs())).rejects.toMatchObject({statusCode: 403});
    });

    it('throws CURRENCY_MISMATCH when request currency does not match accounts', async () => {
        transferKnex.mockImplementationOnce(() => makeJoinFirstChain(fromPrefetch));
        transferKnex.mockImplementationOnce(() => makeJoinFirstChain(toPrefetch));
        await expect(
            initiateTransfer({...baseTransferArgs(), currency: 'EUR'}),
        ).rejects.toMatchObject({code: 'CURRENCY_MISMATCH'});
    });

    it('invokes transfer velocity checks before starting a transaction', async () => {
        transferKnex.mockImplementationOnce(() => makeJoinFirstChain(fromPrefetch));
        transferKnex.mockImplementationOnce(() => makeJoinFirstChain(toPrefetch));
        transferKnex.transaction.mockRejectedValue(new Error('trx not configured in this test'));

        await expect(initiateTransfer(baseTransferArgs())).rejects.toThrow('trx not configured');
        expect(checkTransactionVelocity).toHaveBeenCalledWith('owner-1');
    });
});

describe('initiateTransfer — successful transaction', () => {
    beforeEach(() => {
        let prefetch = 0;
        transferKnex.mockImplementation((table) => {
            if (table !== 'accounts') {
                throw new Error(`Unexpected: ${table}`);
            }
            prefetch += 1;
            if (prefetch === 1) {
                return makeJoinFirstChain(fromPrefetch);
            }
            return makeJoinFirstChain(toPrefetch);
        });

        const lockedRows = [
            {...fromPrefetch, balance: '100.00'},
            {...toPrefetch, balance: '50.00'},
        ].sort((a, b) => String(a.id).localeCompare(String(b.id)));

        const transferRow = {
            id: 'tr-completed-1',
            from_account_id: fromId,
            to_account_id: toId,
            amount: '10.00000000',
            currency: 'USD',
            description: 'test',
            status: 'completed',
            idempotency_key: 'idem-key-1',
            created_at: new Date('2025-01-01T12:00:00.000Z'),
        };

        let trxAccounts = 0;
        let transfersMode = 'select';

        const trx = jest.fn((table) => {
            if (table === 'transfers') {
                if (transfersMode === 'select') {
                    transfersMode = 'insert';
                    return {
                        where: jest.fn().mockReturnThis(),
                        first: jest.fn().mockResolvedValue(null),
                    };
                }
                return {
                    insert: jest.fn().mockReturnValue({
                        returning: jest.fn().mockResolvedValue([transferRow]),
                    }),
                };
            }
            if (table === 'accounts') {
                trxAccounts += 1;
                if (trxAccounts === 1) {
                    return {
                        whereIn: jest.fn().mockReturnThis(),
                        orderBy: jest.fn().mockReturnThis(),
                        forUpdate: jest.fn().mockResolvedValue(lockedRows),
                    };
                }
                return {
                    where: jest.fn().mockReturnThis(),
                    update: jest.fn().mockResolvedValue(1),
                };
            }
            if (table === 'ledger_entries') {
                return {
                    insert: jest.fn().mockResolvedValue([1, 2]),
                };
            }
            if (table === 'outbox_events') {
                return {
                    insert: jest.fn().mockResolvedValue([1]),
                };
            }
            throw new Error(`Unexpected trx table: ${table}`);
        });

        trx.raw = jest
            .fn()
            .mockResolvedValueOnce({})
            .mockResolvedValueOnce({rows: [{daily_debit_total: '0'}]});
        trx.fn = {now: jest.fn(() => 'NOW()')};

        transferKnex.transaction.mockImplementation(async (cb) => cb(trx));
    });

    it('commits transfer, invalidates caches, and returns public transfer shape', async () => {
        const out = await initiateTransfer(baseTransferArgs());
        expect(out.id).toBe('tr-completed-1');
        expect(out.amount).toBe('10.00000000');
        expect(out.status).toBe('completed');
        expect(invalidateAccountCache).toHaveBeenCalledWith(fromId);
        expect(invalidateAccountCache).toHaveBeenCalledWith(toId);
    });
});

describe('initiateTransfer — idempotent hit inside transaction', () => {
    it('returns existing transfer without invalidating cache', async () => {
        const existing = {
            id: 'tr-existing',
            from_account_id: fromId,
            to_account_id: toId,
            amount: '10.00000000',
            currency: 'USD',
            description: null,
            status: 'completed',
            idempotency_key: 'idem-key-1',
            created_at: new Date('2024-06-01'),
        };

        transferKnex.mockImplementationOnce(() => makeJoinFirstChain(fromPrefetch));
        transferKnex.mockImplementationOnce(() => makeJoinFirstChain(toPrefetch));

        const trx = jest.fn((table) => {
            if (table !== 'transfers') {
                throw new Error(table);
            }
            return {
                where: jest.fn().mockReturnThis(),
                first: jest.fn().mockResolvedValue(existing),
            };
        });
        trx.raw = jest.fn().mockResolvedValue({});

        transferKnex.transaction.mockImplementation(async (cb) => cb(trx));

        const out = await initiateTransfer(baseTransferArgs());
        expect(out.id).toBe('tr-existing');
        expect(invalidateAccountCache).not.toHaveBeenCalled();
    });
});

describe('getTransfer', () => {
    it('returns transfer and ledger entries for a participant', async () => {
        const transferRow = {
            id: 'tr-1',
            from_account_id: fromId,
            to_account_id: toId,
            amount: '5.00',
            currency: 'USD',
            description: null,
            status: 'completed',
            idempotency_key: 'k',
            created_at: new Date(),
            from_user_id: 'owner-1',
            to_user_id: 'owner-2',
        };
        const ledgerRows = [
            {
                id: 'le-1',
                account_id: fromId,
                type: 'debit',
                amount: '5.00',
                balance_after: '95.00',
                created_at: new Date(),
            },
            {
                id: 'le-2',
                account_id: toId,
                type: 'credit',
                amount: '5.00',
                balance_after: '55.00',
                created_at: new Date(),
            },
        ];

        transferKnex.mockImplementation((table) => {
            if (table === 'transfers') {
                const c = {
                    join: jest.fn().mockReturnThis(),
                    where: jest.fn().mockReturnThis(),
                    select: jest.fn().mockReturnThis(),
                    first: jest.fn().mockResolvedValue(transferRow),
                };
                return c;
            }
            if (table === 'ledger_entries') {
                return {
                    where: jest.fn().mockReturnThis(),
                    orderBy: jest.fn().mockResolvedValue(ledgerRows),
                };
            }
            throw new Error(table);
        });

        const out = await getTransfer('owner-1', 'tr-1');
        expect(out.transfer.id).toBe('tr-1');
        expect(out.ledgerEntries).toHaveLength(2);
        expect(out.ledgerEntries[0].type).toBe('debit');
    });

    it('throws ForbiddenError when user is not party to the transfer', async () => {
        const transferRow = {
            id: 'tr-1',
            from_user_id: 'a',
            to_user_id: 'b',
        };
        transferKnex.mockImplementation((table) => {
            if (table === 'transfers') {
                return {
                    join: jest.fn().mockReturnThis(),
                    where: jest.fn().mockReturnThis(),
                    select: jest.fn().mockReturnThis(),
                    first: jest.fn().mockResolvedValue(transferRow),
                };
            }
            throw new Error(table);
        });
        await expect(getTransfer('stranger', 'tr-1')).rejects.toMatchObject({statusCode: 403});
    });
});
