import {describe, expect, it, jest, beforeEach} from '@jest/globals';

const redisMock = {
    get: jest.fn(),
    set: jest.fn().mockResolvedValue('OK'),
    del: jest.fn().mockResolvedValue(1),
};

jest.unstable_mockModule('../../src/db/redis.js', () => ({
    redis: redisMock,
}));

const {getCachedAccount, setCachedAccount, invalidateAccountCache} =
    await import('../../src/utils/balanceCache.js');

describe('balanceCache', () => {
    beforeEach(() => {
        redisMock.get.mockReset();
        redisMock.set.mockClear();
        redisMock.del.mockClear();
    });

    it('getCachedAccount returns null when Redis has no key', async () => {
        redisMock.get.mockResolvedValue(null);
        await expect(getCachedAccount('acc-1')).resolves.toBeNull();
        expect(redisMock.get).toHaveBeenCalledWith('balance:acc-1');
    });

    it('getCachedAccount parses JSON payload', async () => {
        const payload = {id: 'acc-1', userId: 'u1', balance: '10.00'};
        redisMock.get.mockResolvedValue(JSON.stringify(payload));
        await expect(getCachedAccount('acc-1')).resolves.toEqual(payload);
    });

    it('setCachedAccount writes JSON with TTL', async () => {
        const account = {id: 'acc-2', balance: '0'};
        await setCachedAccount('acc-2', account);
        expect(redisMock.set).toHaveBeenCalledWith(
            'balance:acc-2',
            JSON.stringify(account),
            'EX',
            30,
        );
    });

    it('invalidateAccountCache deletes the balance key', async () => {
        await invalidateAccountCache('acc-3');
        expect(redisMock.del).toHaveBeenCalledWith('balance:acc-3');
    });
});
