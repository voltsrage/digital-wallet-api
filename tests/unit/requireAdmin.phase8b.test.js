import {describe, expect, it, jest, beforeEach} from '@jest/globals';

const knexMock = jest.fn();

jest.unstable_mockModule('../../src/db/knex.js', () => ({
    knex: knexMock,
}));

const {requireAdmin} = await import('../../src/middleware/requireAdmin.js');

describe('requireAdmin', () => {
    const next = jest.fn();

    beforeEach(() => {
        knexMock.mockReset();
        next.mockClear();
    });

    it('throws when user row is missing', async () => {
        knexMock.mockReturnValue({
            where: jest.fn().mockReturnThis(),
            select: jest.fn().mockReturnThis(),
            first: jest.fn().mockResolvedValue(null),
        });

        await expect(
            requireAdmin({user: {sub: 'missing-id'}}, {}, next),
        ).rejects.toMatchObject({code: 'FORBIDDEN', statusCode: 403});
        expect(next).not.toHaveBeenCalled();
    });

    it('throws when role is not admin', async () => {
        knexMock.mockReturnValue({
            where: jest.fn().mockReturnThis(),
            select: jest.fn().mockReturnThis(),
            first: jest.fn().mockResolvedValue({role: 'user'}),
        });

        await expect(
            requireAdmin({user: {sub: 'u-1'}}, {}, next),
        ).rejects.toMatchObject({code: 'FORBIDDEN'});
    });

    it('calls next for admin role', async () => {
        knexMock.mockReturnValue({
            where: jest.fn().mockReturnThis(),
            select: jest.fn().mockReturnThis(),
            first: jest.fn().mockResolvedValue({role: 'admin'}),
        });

        await requireAdmin({user: {sub: 'admin-id'}}, {}, next);
        expect(next).toHaveBeenCalledTimes(1);
    });
});
