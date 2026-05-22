import {describe, expect, it, jest, beforeEach} from '@jest/globals';

const knexRaw = jest.fn();
jest.unstable_mockModule('../../src/db/knex.js', () => ({
    knex: {raw: knexRaw},
}));

const redisPing = jest.fn();
jest.unstable_mockModule('../../src/db/redis.js', () => ({
    redis: {ping: redisPing},
}));

const mongooseConnection = {readyState: 1};
jest.unstable_mockModule('mongoose', () => ({
    default: {connection: mongooseConnection},
}));

const {liveness, readiness} = await import('../../src/routes/health.js');

function makeRes() {
    const statusJson = jest.fn();
    const res = {
        json: jest.fn(),
        status: jest.fn().mockReturnValue({json: statusJson}),
    };
    return {res, statusJson};
}

describe('liveness', () => {
    it('returns { status: ok }', async () => {
        const {res} = makeRes();
        await liveness({}, res);
        expect(res.json).toHaveBeenCalledWith({status: 'ok'});
    });
});

describe('readiness', () => {
    beforeEach(() => {
        knexRaw.mockReset();
        redisPing.mockReset();
        mongooseConnection.readyState = 1;
        knexRaw.mockResolvedValue({});
        redisPing.mockResolvedValue('PONG');
    });

    it('returns 200 with all checks ok when all dependencies are healthy', async () => {
        const {res, statusJson} = makeRes();
        await readiness({}, res);
        expect(res.status).toHaveBeenCalledWith(200);
        expect(statusJson).toHaveBeenCalledWith({
            status: 'ok',
            checks: {postgres: 'ok', mongo: 'ok', redis: 'ok'},
        });
    });

    it('returns 503 when postgres is unreachable', async () => {
        knexRaw.mockRejectedValue(new Error('connection refused'));
        const {res, statusJson} = makeRes();
        await readiness({}, res);
        expect(res.status).toHaveBeenCalledWith(503);
        expect(statusJson).toHaveBeenCalledWith(
            expect.objectContaining({
                status: 'degraded',
                checks: expect.objectContaining({postgres: 'error', mongo: 'ok', redis: 'ok'}),
            }),
        );
    });

    it('returns 503 when mongo readyState is not 1', async () => {
        mongooseConnection.readyState = 0;
        const {res, statusJson} = makeRes();
        await readiness({}, res);
        expect(res.status).toHaveBeenCalledWith(503);
        expect(statusJson).toHaveBeenCalledWith(
            expect.objectContaining({
                status: 'degraded',
                checks: expect.objectContaining({mongo: 'error', postgres: 'ok', redis: 'ok'}),
            }),
        );
    });

    it('returns 503 when redis is unreachable', async () => {
        redisPing.mockRejectedValue(new Error('ECONNREFUSED'));
        const {res, statusJson} = makeRes();
        await readiness({}, res);
        expect(res.status).toHaveBeenCalledWith(503);
        expect(statusJson).toHaveBeenCalledWith(
            expect.objectContaining({
                status: 'degraded',
                checks: expect.objectContaining({redis: 'error', postgres: 'ok', mongo: 'ok'}),
            }),
        );
    });

    it('reports all three checks as error when every dependency is down', async () => {
        knexRaw.mockRejectedValue(new Error('pg down'));
        redisPing.mockRejectedValue(new Error('redis down'));
        mongooseConnection.readyState = 3;
        const {res, statusJson} = makeRes();
        await readiness({}, res);
        expect(res.status).toHaveBeenCalledWith(503);
        expect(statusJson).toHaveBeenCalledWith({
            status: 'degraded',
            checks: {postgres: 'error', mongo: 'error', redis: 'error'},
        });
    });
});
