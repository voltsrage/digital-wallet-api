import {describe, expect, it, jest, beforeEach} from '@jest/globals';

const redisMock = {
    get: jest.fn().mockResolvedValue(null),
    incr: jest.fn().mockResolvedValue(1),
    expire: jest.fn().mockResolvedValue(1),
};

jest.unstable_mockModule('../../src/db/redis.js', () => ({
    redis: redisMock,
}));

const {checkFailedLoginIpVelocity, recordFailedLoginIp} =
    await import('../../src/utils/velocityCheck.js');

describe('velocityCheck.recordFailedLoginIp', () => {
    beforeEach(() => {
        redisMock.incr.mockClear();
        redisMock.expire.mockClear();
        redisMock.incr.mockResolvedValue(1);
    });

    it('returns 0 when ip is missing', async () => {
        await expect(recordFailedLoginIp('')).resolves.toBe(0);
        await expect(recordFailedLoginIp(null)).resolves.toBe(0);
        expect(redisMock.incr).not.toHaveBeenCalled();
    });

    it('increments Redis and sets TTL on first failure for an IP', async () => {
        redisMock.incr.mockResolvedValueOnce(1);
        const count = await recordFailedLoginIp('203.0.113.9');
        expect(count).toBe(1);
        expect(redisMock.expire).toHaveBeenCalledWith('velocity:failed-login:ip:203.0.113.9', 300);
    });

    it('does not call expire after the first increment', async () => {
        redisMock.incr.mockResolvedValueOnce(2);
        await recordFailedLoginIp('203.0.113.10');
        expect(redisMock.expire).not.toHaveBeenCalled();
    });
});

describe('velocityCheck.checkFailedLoginIpVelocity', () => {
    beforeEach(() => {
        redisMock.get.mockReset();
    });

    it('returns when ip is missing', async () => {
        redisMock.get.mockResolvedValue('99');
        await expect(checkFailedLoginIpVelocity('')).resolves.toBeUndefined();
        await expect(checkFailedLoginIpVelocity(null)).resolves.toBeUndefined();
        expect(redisMock.get).not.toHaveBeenCalled();
    });

    it('allows attempts when count is below the limit', async () => {
        redisMock.get.mockResolvedValue('9');
        await expect(checkFailedLoginIpVelocity('198.51.100.1')).resolves.toBeUndefined();
    });

    it('throws TooManyRequestsError when count reaches the limit', async () => {
        redisMock.get.mockResolvedValue('10');
        await expect(checkFailedLoginIpVelocity('198.51.100.2')).rejects.toMatchObject({
            code: 'LOGIN_RATE_LIMIT',
            statusCode: 429,
        });
    });
});
