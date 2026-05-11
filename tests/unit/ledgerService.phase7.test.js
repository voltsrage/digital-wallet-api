import {describe, expect, it, jest, beforeEach} from '@jest/globals';

const knexMock = jest.fn();
knexMock.raw = jest.fn();

jest.unstable_mockModule('../../src/db/knex.js', () => ({
    knex: knexMock,
}));

const {getLedger, getAccountSummary} = await import('../../src/services/ledgerService.js');

function accountsChainForOwner(userId) {
    return {
        where: jest.fn().mockReturnThis(),
        first: jest.fn().mockResolvedValue({id: 'acc-ledger', user_id: userId}),
    };
}

function accountsChainNotFound() {
    return {
        where: jest.fn().mockReturnThis(),
        first: jest.fn().mockResolvedValue(null),
    };
}

function accountsChainWrongOwner() {
    return {
        where: jest.fn().mockReturnThis(),
        first: jest.fn().mockResolvedValue({id: 'acc-x', user_id: 'someone-else'}),
    };
}

describe('getLedger', () => {
    beforeEach(() => {
        knexMock.mockReset();
        knexMock.raw.mockReset();
    });

    it('throws NotFoundError when account does not exist', async () => {
        knexMock.mockImplementation(() => accountsChainNotFound());
        await expect(getLedger('user-1', 'missing', {})).rejects.toMatchObject({statusCode: 404});
        expect(knexMock.raw).not.toHaveBeenCalled();
    });

    it('throws ForbiddenError when user does not own the account', async () => {
        knexMock.mockImplementation(() => accountsChainWrongOwner());
        await expect(getLedger('user-1', 'acc-x', {})).rejects.toMatchObject({statusCode: 403});
    });

    it('throws INVALID_CURSOR for undecodable cursor', async () => {
        knexMock.mockImplementation(() => accountsChainForOwner('user-1'));
        await expect(
            getLedger('user-1', 'acc-ledger', {before: 'not-valid-base64url!!!'}),
        ).rejects.toMatchObject({code: 'INVALID_CURSOR'});
    });

    it('clamps limit between 1 and 100', async () => {
        knexMock.mockImplementation(() => accountsChainForOwner('user-1'));
        knexMock.raw.mockResolvedValue({rows: []});

        await getLedger('user-1', 'acc-ledger', {limit: '500'});
        expect(knexMock.raw).toHaveBeenCalledWith(
            expect.any(String),
            expect.objectContaining({limit: 100}),
        );

        knexMock.raw.mockClear();
        await getLedger('user-1', 'acc-ledger', {limit: '-5'});
        expect(knexMock.raw).toHaveBeenCalledWith(
            expect.any(String),
            expect.objectContaining({limit: 1}),
        );
    });

    it('returns entries, nextCursor when page is full, and maps row fields', async () => {
        knexMock.mockImplementation(() => accountsChainForOwner('user-1'));
        const t = new Date('2025-03-15T10:00:00.000Z');
        const rows = Array.from({length: 50}, (_, i) => ({
            id: `le-${i}`,
            account_id: 'acc-ledger',
            transfer_id: `tr-${i}`,
            type: i % 2 === 0 ? 'credit' : 'debit',
            amount: '1.00',
            balance_after: '100.00',
            created_at: new Date(t.getTime() - i * 1000),
            description: i === 0 ? 'memo' : null,
            running_balance: '50.25',
        }));
        knexMock.raw.mockResolvedValue({rows});

        const out = await getLedger('user-1', 'acc-ledger', {limit: '50'});
        expect(out.entries).toHaveLength(50);
        expect(out.hasMore).toBe(true);
        expect(out.nextCursor).toBeTruthy();
        expect(out.entries[0].accountId).toBe('acc-ledger');
        expect(out.entries[0].runningBalance).toBe('50.25');
        expect(knexMock.raw).toHaveBeenCalledWith(
            expect.stringContaining('le.account_id = :accountId'),
            expect.objectContaining({
                accountId: 'acc-ledger',
                limit: 50,
            }),
        );
    });
});

describe('getAccountSummary', () => {
    beforeEach(() => {
        knexMock.mockReset();
        knexMock.raw.mockReset();
    });

    it('throws when from is not before to', async () => {
        knexMock.mockImplementation(() => accountsChainForOwner('user-1'));
        await expect(
            getAccountSummary('user-1', 'acc-ledger', {
                from: '2025-01-10T00:00:00.000Z',
                to: '2025-01-05T00:00:00.000Z',
            }),
        ).rejects.toMatchObject({code: 'INVALID_DATE_RANGE'});
    });

    it('throws on invalid ISO dates', async () => {
        knexMock.mockImplementation(() => accountsChainForOwner('user-1'));
        await expect(
            getAccountSummary('user-1', 'acc-ledger', {from: 'not-a-date', to: '2025-01-10T00:00:00.000Z'}),
        ).rejects.toMatchObject({code: 'INVALID_DATE_RANGE'});
    });

    it('queries with resolved date range and maps day aggregates', async () => {
        knexMock.mockImplementation(() => accountsChainForOwner('user-1'));
        const day = new Date('2025-02-01T00:00:00.000Z');
        knexMock.raw.mockResolvedValue({
            rows: [
                {
                    day,
                    entry_count: 3,
                    total_credits: '15.50',
                    total_debits: '5.25',
                    net: '10.25',
                },
            ],
        });

        const out = await getAccountSummary('user-1', 'acc-ledger', {
            from: '2025-01-01T00:00:00.000Z',
            to: '2025-03-01T00:00:00.000Z',
        });

        expect(out.accountId).toBe('acc-ledger');
        expect(out.days).toHaveLength(1);
        expect(out.days[0].entryCount).toBe(3);
        expect(out.days[0].totalCredits).toBe('15.50');
        expect(out.totals.totalCredits).toBe('15.50000000');
        expect(out.totals.totalDebits).toBe('5.25000000');
        expect(out.totals.net).toBe('10.25000000');
        expect(knexMock.raw).toHaveBeenCalledWith(
            expect.stringContaining('account_id = :accountId'),
            expect.objectContaining({
                accountId: 'acc-ledger',
            }),
        );
    });
});
