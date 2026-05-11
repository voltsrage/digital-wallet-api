import {describe, expect, it, jest, beforeEach} from '@jest/globals';

const redisMock = {
    incr: jest.fn(),
    expire: jest.fn().mockResolvedValue(1),
    get: jest.fn(),
};

const knexMock = jest.fn();

jest.unstable_mockModule('../../src/db/redis.js', () => ({
    redis: redisMock,
}));

jest.unstable_mockModule('../../src/db/knex.js', () => ({
    knex: knexMock,
}));

const {
    checkTransactionVelocity,
    getTransferVelocity,
    checkNewBeneficiaryVelocity,
} = await import('../../src/utils/velocityCheck.js');

describe('checkTransactionVelocity (Phase 8 gate)', () => {
    beforeEach(() => {
        redisMock.incr.mockReset();
        redisMock.expire.mockReset();
    });

    it('throws TRANSFER_RATE_LIMIT when count exceeds the window limit', async () => {
        redisMock.incr.mockResolvedValue(21);
        await expect(checkTransactionVelocity('user-1')).rejects.toMatchObject({
            code: 'TRANSFER_RATE_LIMIT',
            statusCode: 429,
        });
    });

    it('returns the current count when within limit', async () => {
        redisMock.incr.mockResolvedValue(5);
        await expect(checkTransactionVelocity('user-1')).resolves.toBe(5);
    });
});

describe('getTransferVelocity', () => {
    beforeEach(() => {
        redisMock.get.mockReset();
    });

    it('parses Redis string as integer', async () => {
        redisMock.get.mockResolvedValue('12');
        await expect(getTransferVelocity('user-2')).resolves.toBe(12);
    });

    it('returns 0 when Redis has no key', async () => {
        redisMock.get.mockResolvedValue(null);
        await expect(getTransferVelocity('user-3')).resolves.toBe(0);
    });
});

describe('checkNewBeneficiaryVelocity (Phase 8b gate)', () => {
    beforeEach(() => {
        redisMock.incr.mockReset();
        redisMock.expire.mockReset();
        knexMock.mockReset();
    });

    function priorCountChain(count) {
        return {
            join: jest.fn().mockReturnThis(),
            where: jest.fn().mockReturnThis(),
            count: jest.fn().mockReturnValue({
                first: jest.fn().mockResolvedValue({count: String(count)}),
            }),
        };
    }

    it('returns without Redis work when recipient is already known', async () => {
        knexMock.mockImplementation(() => priorCountChain(2));
        await expect(
            checkNewBeneficiaryVelocity('user-1', 'acc-to'),
        ).resolves.toBeUndefined();
        expect(redisMock.incr).not.toHaveBeenCalled();
    });

    it('allows up to NEW_BENEFICIARY_LIMIT new recipients then throws', async () => {
        knexMock.mockImplementation(() => priorCountChain(0));
        redisMock.incr.mockResolvedValueOnce(1);
        await expect(checkNewBeneficiaryVelocity('user-1', 'acc-a')).resolves.toBeUndefined();

        redisMock.incr.mockResolvedValueOnce(3);
        await expect(checkNewBeneficiaryVelocity('user-1', 'acc-b')).resolves.toBeUndefined();

        redisMock.incr.mockResolvedValueOnce(4);
        await expect(checkNewBeneficiaryVelocity('user-1', 'acc-c')).rejects.toMatchObject({
            code: 'NEW_BENEFICIARY_RATE_LIMIT',
        });
    });
});
