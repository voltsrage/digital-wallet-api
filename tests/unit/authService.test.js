import {describe, expect, it, jest, beforeEach} from '@jest/globals';

process.env.JWT_SECRET = 'auth-svc-access';
process.env.JWT_REFRESH_SECRET = 'auth-svc-refresh';

const redisMock = {
    set: jest.fn().mockResolvedValue('OK'),
    get: jest.fn().mockResolvedValue(null),
    del: jest.fn().mockResolvedValue(1),
    exists: jest.fn().mockResolvedValue(1),
};

const velocityMock = {
    checkFailedLoginIpVelocity: jest.fn().mockResolvedValue(undefined),
    recordFailedLoginIp: jest.fn().mockResolvedValue(1),
};

/** @type {Record<string, unknown>} */
const authTestState = {
    mode: '',
    existingRow: null,
    newUserRow: null,
    loginUserRow: null,
    updateReturningRow: null,
    refreshUserRow: null,
    _call: 0,
};

jest.unstable_mockModule('../../src/db/redis.js', () => ({
    redis: redisMock,
}));

jest.unstable_mockModule('../../src/utils/velocityCheck.js', () => velocityMock);

jest.unstable_mockModule('../../src/models/AuditEvent.js', () => ({
    AuditEvent: {create: jest.fn().mockResolvedValue({})},
}));

jest.unstable_mockModule('bcrypt', () => ({
    default: {
        hash: jest.fn().mockResolvedValue('$2b$12$mockedhash'),
        compare: jest.fn(),
    },
}));

jest.unstable_mockModule('../../src/db/knex.js', () => {
    const knexFn = jest.fn((table) => {
        if (table !== 'users') {
            throw new Error(`Unexpected knex table: ${table}`);
        }
        authTestState._call = (authTestState._call ?? 0) + 1;
        return buildUsersBuilder(authTestState._call, authTestState);
    });
    knexFn.fn = {now: jest.fn(() => '?')};
    knexFn.raw = jest.fn(() => ({}));
    return {knex: knexFn};
});

/**
 * @param {number} callIndex
 * @param {typeof authTestState} s
 */
function buildUsersBuilder(callIndex, s) {
    switch (s.mode) {
        case 'REGISTER_NEW': {
            if (callIndex === 1) {
                return {
                    where: jest.fn().mockReturnThis(),
                    first: jest.fn().mockResolvedValue(null),
                };
            }
            if (callIndex === 2) {
                return {
                    insert: jest.fn().mockReturnValue({
                        returning: jest.fn().mockResolvedValue([s.newUserRow]),
                    }),
                };
            }
            break;
        }
        case 'REGISTER_CONFLICT': {
            return {
                where: jest.fn().mockReturnThis(),
                first: jest.fn().mockResolvedValue(s.existingRow),
            };
        }
        case 'LOGIN_LOOKUP': {
            return {
                where: jest.fn().mockReturnThis(),
                select: jest.fn().mockReturnThis(),
                first: jest.fn().mockResolvedValue(s.loginUserRow),
            };
        }
        case 'LOGIN_FAIL_UPDATE': {
            if (callIndex === 1) {
                return {
                    where: jest.fn().mockReturnThis(),
                    select: jest.fn().mockReturnThis(),
                    first: jest.fn().mockResolvedValue(s.loginUserRow),
                };
            }
            return {
                where: jest.fn().mockReturnThis(),
                update: jest.fn().mockReturnValue({
                    returning: jest.fn().mockResolvedValue([s.updateReturningRow]),
                }),
            };
        }
        case 'LOGIN_SUCCESS': {
            if (callIndex === 1) {
                return {
                    where: jest.fn().mockReturnThis(),
                    select: jest.fn().mockReturnThis(),
                    first: jest.fn().mockResolvedValue(s.loginUserRow),
                };
            }
            return {
                where: jest.fn().mockReturnThis(),
                update: jest.fn().mockResolvedValue(1),
            };
        }
        case 'REFRESH_USER': {
            return {
                where: jest.fn().mockReturnThis(),
                select: jest.fn().mockReturnThis(),
                first: jest.fn().mockResolvedValue(s.refreshUserRow),
            };
        }
        default:
            break;
    }
    throw new Error(`Unhandled authTestState: mode=${s.mode} callIndex=${callIndex}`);
}

const {register, login, refresh, logout} = await import('../../src/services/authService.js');
const {AuditEvent} = await import('../../src/models/AuditEvent.js');
const {issueRefreshToken} = await import('../../src/utils/tokens.js');
const bcrypt = (await import('bcrypt')).default;

describe('authService.register', () => {
    beforeEach(() => {
        authTestState._call = 0;
        authTestState.mode = 'REGISTER_NEW';
        authTestState.newUserRow = {
            id: 'usr-new',
            email: 'reg@example.com',
            display_name: 'Reg User',
            status: 'active',
            created_at: new Date('2024-06-01T00:00:00.000Z'),
        };
        redisMock.set.mockClear();
        redisMock.exists.mockResolvedValue(1);
    });

    it('throws ConflictError when email is already registered', async () => {
        authTestState.mode = 'REGISTER_CONFLICT';
        authTestState.existingRow = {id: 'other'};
        await expect(
            register({email: 'taken@example.com', password: 'pw', displayName: 'X'}),
        ).rejects.toMatchObject({code: 'EMAIL_TAKEN', statusCode: 409});
    });

    it('hashes password and returns tokens for a new user', async () => {
        const out = await register({
            email: 'reg@example.com',
            password: 'plain-secret',
            displayName: 'Reg User',
        });

        expect(bcrypt.hash).toHaveBeenCalledWith('plain-secret', 12);
        expect(out.user).toEqual({
            id: 'usr-new',
            email: 'reg@example.com',
            displayName: 'Reg User',
            createdAt: authTestState.newUserRow.created_at,
        });
        expect(out.accessToken).toBeDefined();
        expect(out.refreshToken).toBeDefined();
    });
});

describe('authService.login', () => {
    beforeEach(() => {
        authTestState._call = 0;
        velocityMock.checkFailedLoginIpVelocity.mockClear();
        velocityMock.recordFailedLoginIp.mockClear();
        AuditEvent.create.mockClear();
        bcrypt.compare.mockReset();
        authTestState.loginUserRow = {
            id: 'usr-1',
            email: 'login@example.com',
            display_name: 'L',
            status: 'active',
            password_hash: 'stored-hash',
            failed_login_count: 0,
            locked_until: null,
        };
    });

    it('invokes IP velocity check before database lookup', async () => {
        authTestState.mode = 'LOGIN_LOOKUP';
        authTestState.loginUserRow = null;
        await expect(
            login({
                email: 'nobody@example.com',
                password: 'x',
                ipAddress: '10.0.0.1',
                userAgent: 'jest',
            }),
        ).rejects.toMatchObject({statusCode: 401});
        expect(velocityMock.checkFailedLoginIpVelocity).toHaveBeenCalledWith('10.0.0.1');
    });

    it('throws UnauthorizedError for unknown email', async () => {
        authTestState.mode = 'LOGIN_LOOKUP';
        authTestState.loginUserRow = null;
        await expect(
            login({email: 'missing@example.com', password: 'x', ipAddress: '10.0.0.2', userAgent: null}),
        ).rejects.toMatchObject({statusCode: 401});
    });

    it('throws for suspended user without revealing suspension', async () => {
        authTestState.mode = 'LOGIN_LOOKUP';
        authTestState.loginUserRow = {...authTestState.loginUserRow, status: 'suspended'};
        await expect(
            login({
                email: 'login@example.com',
                password: 'any',
                ipAddress: '10.0.0.3',
                userAgent: null,
            }),
        ).rejects.toThrow('Invalid email or password');
    });

    it('throws for account locked by locked_until', async () => {
        authTestState.mode = 'LOGIN_LOOKUP';
        authTestState.loginUserRow = {
            ...authTestState.loginUserRow,
            locked_until: new Date(Date.now() + 60 * 60 * 1000),
        };
        await expect(
            login({
                email: 'login@example.com',
                password: 'pw',
                ipAddress: '10.0.0.4',
                userAgent: null,
            }),
        ).rejects.toThrow('Invalid email or password');
    });

    it('increments failures and records IP on wrong password', async () => {
        authTestState.mode = 'LOGIN_FAIL_UPDATE';
        authTestState.updateReturningRow = {failed_login_count: 3, locked_until: null};
        bcrypt.compare.mockResolvedValue(false);

        await expect(
            login({
                email: 'login@example.com',
                password: 'wrong',
                ipAddress: '10.0.0.5',
                userAgent: 'ua',
            }),
        ).rejects.toThrow('Invalid email or password');

        expect(velocityMock.recordFailedLoginIp).toHaveBeenCalledWith('10.0.0.5');
        expect(AuditEvent.create).toHaveBeenCalledWith(
            expect.objectContaining({
                eventType: 'LOGIN_FAILED',
                actorId: 'usr-1',
            }),
        );
    });

    it('writes LOGIN_LOCKED audit when failure count reaches threshold', async () => {
        authTestState.mode = 'LOGIN_FAIL_UPDATE';
        authTestState.updateReturningRow = {
            failed_login_count: 10,
            locked_until: new Date('2030-01-01T00:00:00.000Z'),
        };
        bcrypt.compare.mockResolvedValue(false);

        await expect(
            login({
                email: 'login@example.com',
                password: 'wrong',
                ipAddress: '10.0.0.6',
                userAgent: null,
            }),
        ).rejects.toThrow('Invalid email or password');

        const types = AuditEvent.create.mock.calls.map((c) => c[0].eventType);
        expect(types).toContain('LOGIN_FAILED');
        expect(types).toContain('LOGIN_LOCKED');
    });

    it('resets lockout and returns tokens on successful login', async () => {
        authTestState.mode = 'LOGIN_SUCCESS';
        bcrypt.compare.mockResolvedValue(true);

        const out = await login({
            email: 'login@example.com',
            password: 'correct',
            ipAddress: '10.0.0.7',
            userAgent: 'ua',
        });

        expect(AuditEvent.create).toHaveBeenCalledWith(
            expect.objectContaining({eventType: 'LOGIN_SUCCESS'}),
        );
        expect(out.accessToken).toBeDefined();
        expect(out.refreshToken).toBeDefined();
    });
});

describe('authService.refresh', () => {
    beforeEach(() => {
        authTestState._call = 0;
        redisMock.set.mockClear();
        redisMock.del.mockClear();
        redisMock.exists.mockResolvedValue(1);
    });

    it('throws when refresh token is invalid', async () => {
        await expect(refresh('not-a-jwt')).rejects.toMatchObject({statusCode: 401});
    });

    it('throws when user is suspended after token validates', async () => {
        const token = await issueRefreshToken('usr-susp');
        authTestState.mode = 'REFRESH_USER';
        authTestState.refreshUserRow = {
            id: 'usr-susp',
            email: 's@example.com',
            display_name: null,
            status: 'suspended',
        };

        await expect(refresh(token)).rejects.toMatchObject({statusCode: 401});
    });

    it('rotates refresh token and returns a new pair', async () => {
        const token = await issueRefreshToken('usr-ok');
        authTestState.mode = 'REFRESH_USER';
        authTestState.refreshUserRow = {
            id: 'usr-ok',
            email: 'ok@example.com',
            display_name: 'OK',
            status: 'active',
        };

        const out = await refresh(token);
        expect(out.accessToken).toBeDefined();
        expect(out.refreshToken).toBeDefined();
        expect(redisMock.del).toHaveBeenCalled();
        expect(out.refreshToken).not.toBe(token);
    });
});

describe('authService.logout', () => {
    beforeEach(() => {
        redisMock.del.mockClear();
        redisMock.exists.mockResolvedValue(1);
    });

    it('resolves when token is already invalid', async () => {
        await expect(logout('bad-token')).resolves.toBeUndefined();
        expect(redisMock.del).not.toHaveBeenCalled();
    });

    it('revokes refresh token when valid', async () => {
        const token = await issueRefreshToken('usr-out');
        await logout(token);
        expect(redisMock.del).toHaveBeenCalled();
    });
});
