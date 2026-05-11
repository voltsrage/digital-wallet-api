import {describe, expect, it, jest, beforeEach} from '@jest/globals';
import jwt from 'jsonwebtoken';

process.env.JWT_SECRET = 'auth-mw-secret';

const {authenticate} = await import('../../src/middleware/authenticate.js');

describe('authenticate middleware', () => {
    const res = {};
    const next = jest.fn();

    beforeEach(() => {
        next.mockClear();
    });

    it('throws when Authorization header is missing', () => {
        expect(() => authenticate({headers: {}}, res, next)).toThrow('Authorization header missing');
        expect(next).not.toHaveBeenCalled();
    });

    it('throws when Authorization is not Bearer', () => {
        expect(() =>
            authenticate({headers: {authorization: 'Basic x'}}, res, next),
        ).toThrow('Authorization header missing');
    });

    it('throws when token is invalid', () => {
        expect(() =>
            authenticate({headers: {authorization: 'Bearer not-a-token'}}, res, next),
        ).toThrow('Invalid or expired token');
    });

    it('sets req.user and calls next for a valid access token', () => {
        const token = jwt.sign({sub: 'user-abc'}, process.env.JWT_SECRET, {expiresIn: '5m'});
        const req = {headers: {authorization: `Bearer ${token}`}};
        authenticate(req, res, next);
        expect(req.user.sub).toBe('user-abc');
        expect(next).toHaveBeenCalledTimes(1);
    });
});
