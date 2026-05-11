import {describe, expect, it, jest} from '@jest/globals';

const {withSerializableRetry, PG_UNIQUE_VIOLATION} =
    await import('../../src/utils/withSerializableRetry.js');

describe('withSerializableRetry', () => {
    it('returns the function result on first success', async () => {
        const fn = jest.fn().mockResolvedValue('ok');
        await expect(withSerializableRetry(fn)).resolves.toBe('ok');
        expect(fn).toHaveBeenCalledTimes(1);
    });

    it('retries on PostgreSQL serialization failure (40001) and then succeeds', async () => {
        const err = new Error('conflict');
        err.code = '40001';
        const fn = jest.fn().mockRejectedValueOnce(err).mockResolvedValueOnce('recovered');
        await expect(withSerializableRetry(fn)).resolves.toBe('recovered');
        expect(fn).toHaveBeenCalledTimes(2);
    });

    it('rethrows non-serialization errors immediately', async () => {
        const err = new Error('validation');
        err.code = '23514';
        const fn = jest.fn().mockRejectedValue(err);
        await expect(withSerializableRetry(fn)).rejects.toThrow('validation');
        expect(fn).toHaveBeenCalledTimes(1);
    });

    it('throws 503 SERIALIZATION_FAILURE after exhausting retries', async () => {
        const err = new Error('still failing');
        err.code = '40001';
        const fn = jest.fn().mockRejectedValue(err);
        await expect(withSerializableRetry(fn)).rejects.toMatchObject({
            code: 'SERIALIZATION_FAILURE',
            statusCode: 503,
        });
        expect(fn).toHaveBeenCalledTimes(3);
    });

    it('exports PG_UNIQUE_VIOLATION for transfer catch handling', () => {
        expect(PG_UNIQUE_VIOLATION).toBe('23505');
    });
});
