import {describe, expect, it, jest, beforeEach} from '@jest/globals';

process.env.JWT_SECRET = 'test-access-secret';
process.env.JWT_REFRESH_SECRET = 'test-refresh-secret';

const redisMock = {
    set: jest.fn().mockResolvedValue('OK'),
    get: jest.fn().mockResolvedValue(null),
    del: jest.fn().mockResolvedValue(1),
    exists: jest.fn().mockResolvedValue(1),
};

jest.unstable_mockModule('../../src/db/redis.js', () => ({
    redis: redisMock,
}));

const {signAccessToken, issueRefreshToken, validateRefreshToken, revokeRefreshToken} =
    await import('../../src/utils/tokens.js');
const jwt = (await import('jsonwebtoken')).default;

describe('tokens.signAccessToken', () => {
    it('embeds user id as sub and verifies with JWT_SECRET', () => {
        const token = signAccessToken('user-uuid-1');
        const payload = jwt.verify(token, process.env.JWT_SECRET);
        expect(payload.sub).toBe('user-uuid-1');
    });
});

describe('tokens.issueRefreshToken', () => {
    beforeEach(() => {
        redisMock.set.mockClear();
    });

    it('stores refresh marker in Redis and returns a refresh JWT', async () => {
        const token = await issueRefreshToken('user-2');
        const payload = jwt.verify(token, process.env.JWT_REFRESH_SECRET);
        expect(payload.type).toBe('refresh');
        expect(payload.sub).toBe('user-2');
        expect(payload.jti).toBeDefined();
        expect(redisMock.set).toHaveBeenCalledWith(
            `refresh:user-2:${payload.jti}`,
            'valid',
            'EX',
            7 * 24 * 60,
        );
    });
});

describe('tokens.validateRefreshToken', () => {
    beforeEach(() => {
        redisMock.exists.mockResolvedValue(1);
    });

    it('returns null for a malformed token', async () => {
        await expect(validateRefreshToken('not-a-jwt')).resolves.toBeNull();
    });

    it('returns null when JWT type is not refresh', async () => {
        const wrongType = jwt.sign(
            {sub: 'u', jti: 'tid', type: 'access'},
            process.env.JWT_REFRESH_SECRET,
        );
        await expect(validateRefreshToken(wrongType)).resolves.toBeNull();
    });

    it('returns null when Redis key is missing', async () => {
        redisMock.exists.mockResolvedValueOnce(0);
        const token = await issueRefreshToken('user-3');
        await expect(validateRefreshToken(token)).resolves.toBeNull();
    });

    it('returns userId and tokenId when token is valid', async () => {
        const token = await issueRefreshToken('user-4');
        const payload = jwt.verify(token, process.env.JWT_REFRESH_SECRET);
        const result = await validateRefreshToken(token);
        expect(result).toEqual({userId: 'user-4', tokenId: payload.jti});
    });
});

describe('tokens.revokeRefreshToken', () => {
    it('deletes the Redis refresh key', async () => {
        await revokeRefreshToken('user-5', 'token-id-99');
        expect(redisMock.del).toHaveBeenCalledWith('refresh:user-5:token-id-99');
    });
});
