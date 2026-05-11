import {describe, expect, it, jest, beforeEach} from '@jest/globals';

const handleTransferCompleted = jest.fn().mockResolvedValue(undefined);

jest.unstable_mockModule('../../src/services/outboxHandlers.js', () => ({
    handleTransferCompleted,
}));

const loggerWarn = jest.fn();
const loggerError = jest.fn();
const loggerInfo = jest.fn();

jest.unstable_mockModule('../../src/utils/logger.js', () => ({
    logger: {
        warn: loggerWarn,
        error: loggerError,
        info: loggerInfo,
    },
}));

const knexTransaction = jest.fn();

const knexMock = jest.fn();
knexMock.transaction = knexTransaction;

jest.unstable_mockModule('../../src/db/knex.js', () => ({
    knex: knexMock,
}));

const {pollOnce} = await import('../../src/services/outboxPoller.js');

function createTrx({rows}) {
    const trxFn = jest.fn((table) => {
        if (table !== 'outbox_events') {
            throw new Error(`Unexpected trx table: ${table}`);
        }
        return {
            where: jest.fn().mockReturnThis(),
            update: jest.fn().mockResolvedValue(1),
        };
    });
    trxFn.raw = jest.fn().mockResolvedValue({rows});
    return trxFn;
}

describe('pollOnce', () => {
    beforeEach(() => {
        knexTransaction.mockReset();
        handleTransferCompleted.mockClear();
        loggerWarn.mockClear();
        loggerError.mockClear();
        loggerInfo.mockClear();
    });

    it('does nothing when no pending events', async () => {
        knexTransaction.mockImplementation(async (cb) => {
            await cb(createTrx({rows: []}));
        });

        await pollOnce();

        expect(handleTransferCompleted).not.toHaveBeenCalled();
        expect(loggerInfo).not.toHaveBeenCalled();
    });

    it('parses string payload, runs handler, and marks event processed', async () => {
        const payload = {
            transferId: 'tr-99',
            fromAccountId: 'a1',
            toAccountId: 'a2',
            fromAccountNumber: 'F',
            toAccountNumber: 'T',
            fromUserId: 'u1',
            toUserId: 'u2',
            fromUserDisplayName: 'X',
            toUserDisplayName: 'Y',
            amount: '1',
            currency: 'USD',
            description: null,
            ipAddress: null,
            userAgent: null,
        };
        const rows = [
            {
                id: 'evt-1',
                event_type: 'TRANSFER_COMPLETED',
                payload: JSON.stringify(payload),
            },
        ];

        knexTransaction.mockImplementation(async (cb) => {
            await cb(createTrx({rows}));
        });

        await pollOnce();

        expect(handleTransferCompleted).toHaveBeenCalledTimes(1);
        expect(handleTransferCompleted).toHaveBeenCalledWith(payload);
        expect(loggerInfo).toHaveBeenCalledWith({count: 1}, expect.any(String));
    });

    it('passes through object payload without JSON.parse', async () => {
        const payload = {transferId: 'tr-obj', fromAccountId: 'a', toAccountId: 'b'};
        const rows = [{id: 'evt-2', event_type: 'TRANSFER_COMPLETED', payload}];

        knexTransaction.mockImplementation(async (cb) => {
            await cb(createTrx({rows}));
        });

        await pollOnce();
        expect(handleTransferCompleted).toHaveBeenCalledWith(payload);
    });

    it('marks unknown event types processed and logs a warning', async () => {
        const rows = [{id: 'evt-bad', event_type: 'UNKNOWN_TYPE', payload: {}}];

        knexTransaction.mockImplementation(async (cb) => {
            await cb(createTrx({rows}));
        });

        await pollOnce();

        expect(handleTransferCompleted).not.toHaveBeenCalled();
        expect(loggerWarn).toHaveBeenCalledWith(
            {eventType: 'UNKNOWN_TYPE', eventId: 'evt-bad'},
            expect.any(String),
        );
    });

    it('swallows errors from the transaction and logs them', async () => {
        knexTransaction.mockRejectedValue(new Error('connection lost'));

        await expect(pollOnce()).resolves.toBeUndefined();
        expect(loggerError).toHaveBeenCalledWith({err: expect.any(Error)}, expect.any(String));
    });
});
