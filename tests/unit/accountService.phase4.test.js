import {describe, expect, it, jest, beforeEach, beforeAll} from '@jest/globals';

const balanceCacheMock = {
    getCachedAccount: jest.fn(),
    setCachedAccount: jest.fn().mockResolvedValue(undefined),
    invalidateAccountCache: jest.fn().mockResolvedValue(undefined),
};

jest.unstable_mockModule('../../src/utils/balanceCache.js', () => balanceCacheMock);

jest.unstable_mockModule('../../src/models/AuditEvent.js', () => ({
    AuditEvent: {create: jest.fn().mockResolvedValue({})},
}));

jest.unstable_mockModule('../../src/db/knex.js', () => {
    const knexFn = jest.fn((table) => {
        if (table !== 'accounts') {
            throw new Error(`Unexpected table: ${table}`);
        }
        return buildAccountsBuilder(accountKnexState);
    });
    knexFn.fn = {now: jest.fn(() => '?')};
    return {knex: knexFn};
});

/**
 * @param {{ mode: string; accountRow?: object | null; updatedRow?: object | null; listRows?: object[] }} state
 */
function buildAccountsBuilder(state) {
    switch (state.mode) {
        case 'CREATE':
            return {
                insert: jest.fn().mockReturnValue({
                    returning: jest.fn().mockResolvedValue([state.updatedRow]),
                }),
            };
        case 'LIST': {
            const chain = {
                where: jest.fn().mockReturnThis(),
                orderBy: jest.fn().mockResolvedValue(state.listRows ?? []),
            };
            return chain;
        }
        case 'SINGLE_FIRST':
            return {
                where: jest.fn().mockReturnThis(),
                first: jest.fn().mockResolvedValue(state.accountRow ?? null),
            };
        case 'UPDATE_RETURNING':
            return {
                where: jest.fn().mockReturnThis(),
                update: jest.fn().mockReturnValue({
                    returning: jest.fn().mockResolvedValue([state.updatedRow]),
                }),
            };
        default:
            throw new Error(`Unknown mode: ${state.mode}`);
    }
}

const accountKnexState = {
    mode: 'LIST',
    accountRow: null,
    updatedRow: null,
    listRows: [],
};

const {
    createAccount,
    listAccounts,
    getAccount,
    freezeAccount,
    unfreezeAccount,
    closeAccount,
} = await import('../../src/services/accountService.js');
const {AuditEvent} = await import('../../src/models/AuditEvent.js');

let knexMod;

beforeAll(async () => {
    knexMod = await import('../../src/db/knex.js');
});

beforeEach(() => {
    knexMod.knex.mockReset();
    knexMod.knex.mockImplementation((table) => {
        if (table !== 'accounts') {
            throw new Error(`Unexpected table: ${table}`);
        }
        return buildAccountsBuilder(accountKnexState);
    });
});

const baseAccountRow = (overrides = {}) => ({
    id: 'acc-1',
    user_id: 'user-1',
    account_number: 'ACC-00001234',
    currency: 'USD',
    balance: '100.00000000',
    status: 'active',
    daily_limit: '10000.00000000',
    created_at: new Date('2024-01-01'),
    updated_at: new Date('2024-01-02'),
    ...overrides,
});

describe('accountService.createAccount', () => {
    beforeEach(() => {
        accountKnexState.mode = 'CREATE';
        accountKnexState.updatedRow = baseAccountRow({balance: '0.00000000'});
        AuditEvent.create.mockClear();
    });

    it('inserts an account and writes ACCOUNT_CREATED audit', async () => {
        const out = await createAccount('user-1', {currency: 'USD'});
        expect(out.id).toBe('acc-1');
        expect(out.balance).toBe('0.00000000');
        expect(out.status).toBe('active');
        expect(out.accountNumber).toMatch(/^ACC-\d{8}$/);
        expect(AuditEvent.create).toHaveBeenCalledWith(
            expect.objectContaining({
                eventType: 'ACCOUNT_CREATED',
                actorId: 'user-1',
                targetType: 'account',
            }),
        );
    });
});

describe('accountService.listAccounts', () => {
    beforeEach(() => {
        accountKnexState.mode = 'LIST';
        accountKnexState.listRows = [
            baseAccountRow({id: 'a1', account_number: 'ACC-00000001'}),
            baseAccountRow({id: 'a2', account_number: 'ACC-00000002', balance: '5.00'}),
        ];
    });

    it('returns mapped public accounts for the user', async () => {
        const rows = await listAccounts('user-1');
        expect(rows).toHaveLength(2);
        expect(rows[0].accountNumber).toBe('ACC-00000001');
        expect(rows[1].balance).toBe('5.00');
    });
});

describe('accountService.getAccount', () => {
    beforeEach(() => {
        balanceCacheMock.getCachedAccount.mockReset();
        balanceCacheMock.setCachedAccount.mockClear();
    });

    it('returns cached account when present and user matches', async () => {
        const cached = {
            id: 'acc-1',
            userId: 'user-1',
            accountNumber: 'ACC-X',
            currency: 'USD',
            balance: '1',
            status: 'active',
            dailyLimit: '10000',
            createdAt: new Date(),
            updatedAt: new Date(),
        };
        balanceCacheMock.getCachedAccount.mockResolvedValue(cached);
        await expect(getAccount('user-1', 'acc-1')).resolves.toEqual(cached);
        expect(balanceCacheMock.setCachedAccount).not.toHaveBeenCalled();
    });

    it('throws ForbiddenError when cache hit belongs to another user', async () => {
        balanceCacheMock.getCachedAccount.mockResolvedValue({
            id: 'acc-1',
            userId: 'other-user',
            accountNumber: 'ACC-X',
            currency: 'USD',
            balance: '0',
            status: 'active',
            dailyLimit: '10000',
            createdAt: new Date(),
            updatedAt: new Date(),
        });
        await expect(getAccount('user-1', 'acc-1')).rejects.toMatchObject({statusCode: 403});
    });

    it('loads from DB, caches, and returns when cache misses', async () => {
        balanceCacheMock.getCachedAccount.mockResolvedValue(null);
        accountKnexState.mode = 'SINGLE_FIRST';
        accountKnexState.accountRow = baseAccountRow();

        const out = await getAccount('user-1', 'acc-1');
        expect(out.userId).toBe('user-1');
        expect(balanceCacheMock.setCachedAccount).toHaveBeenCalledWith(
            'acc-1',
            expect.objectContaining({id: 'acc-1'}),
        );
    });

    it('throws NotFoundError when account does not exist', async () => {
        balanceCacheMock.getCachedAccount.mockResolvedValue(null);
        accountKnexState.mode = 'SINGLE_FIRST';
        accountKnexState.accountRow = null;
        await expect(getAccount('user-1', 'missing')).rejects.toMatchObject({statusCode: 404});
    });
});

describe('accountService.freezeAccount', () => {
    beforeEach(() => {
        AuditEvent.create.mockClear();
    });

    it('updates status to frozen and invalidates cache', async () => {
        let n = 0;
        knexMod.knex.mockImplementation((table) => {
            if (table !== 'accounts') {
                throw new Error(table);
            }
            n += 1;
            if (n === 1) {
                return buildAccountsBuilder({
                    mode: 'SINGLE_FIRST',
                    accountRow: baseAccountRow({status: 'active'}),
                });
            }
            return buildAccountsBuilder({
                mode: 'UPDATE_RETURNING',
                updatedRow: baseAccountRow({status: 'frozen'}),
            });
        });

        const out = await freezeAccount('user-1', 'acc-1');
        expect(out.status).toBe('frozen');
        expect(balanceCacheMock.invalidateAccountCache).toHaveBeenCalledWith('acc-1');
        expect(AuditEvent.create).toHaveBeenCalledWith(
            expect.objectContaining({eventType: 'ACCOUNT_FROZEN'}),
        );
    });

    it('rejects invalid transition from frozen to frozen', async () => {
        accountKnexState.mode = 'SINGLE_FIRST';
        accountKnexState.accountRow = baseAccountRow({status: 'frozen'});
        await expect(freezeAccount('user-1', 'acc-1')).rejects.toMatchObject({
            code: 'INVALID_STATUS_TRANSITION',
        });
    });
});

describe('accountService.unfreezeAccount', () => {
    it('activates a frozen account and writes ACCOUNT_UNFROZEN', async () => {
        let n = 0;
        knexMod.knex.mockImplementation((table) => {
            if (table !== 'accounts') {
                throw new Error(table);
            }
            n += 1;
            if (n === 1) {
                return buildAccountsBuilder({
                    mode: 'SINGLE_FIRST',
                    accountRow: baseAccountRow({status: 'frozen'}),
                });
            }
            return buildAccountsBuilder({
                mode: 'UPDATE_RETURNING',
                updatedRow: baseAccountRow({status: 'active'}),
            });
        });
        AuditEvent.create.mockClear();

        const out = await unfreezeAccount('user-1', 'acc-1');
        expect(out.status).toBe('active');
        expect(AuditEvent.create).toHaveBeenCalledWith(
            expect.objectContaining({eventType: 'ACCOUNT_UNFROZEN'}),
        );
    });
});

describe('accountService.closeAccount', () => {
    it('requires zero balance', async () => {
        accountKnexState.mode = 'SINGLE_FIRST';
        accountKnexState.accountRow = baseAccountRow({balance: '10.00', status: 'active'});
        await expect(closeAccount('user-1', 'acc-1')).rejects.toMatchObject({
            code: 'ACCOUNT_HAS_BALANCE',
        });
    });

    it('closes when balance is zero and writes ACCOUNT_CLOSED', async () => {
        let n = 0;
        knexMod.knex.mockImplementation((table) => {
            if (table !== 'accounts') {
                throw new Error(table);
            }
            n += 1;
            if (n === 1) {
                return buildAccountsBuilder({
                    mode: 'SINGLE_FIRST',
                    accountRow: baseAccountRow({balance: '0.00000000', status: 'active'}),
                });
            }
            return buildAccountsBuilder({
                mode: 'UPDATE_RETURNING',
                updatedRow: baseAccountRow({status: 'closed', balance: '0.00000000'}),
            });
        });
        AuditEvent.create.mockClear();

        const out = await closeAccount('user-1', 'acc-1');
        expect(out.status).toBe('closed');
        expect(AuditEvent.create).toHaveBeenCalledWith(
            expect.objectContaining({eventType: 'ACCOUNT_CLOSED'}),
        );
    });
});
