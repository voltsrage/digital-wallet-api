import {describe, expect, it, jest, beforeEach} from '@jest/globals';

const transactionReceiptUpdateOne = jest.fn().mockResolvedValue({});
const auditEventUpdateOne = jest.fn().mockResolvedValue({});
const computeAndWriteFraudSignal = jest.fn().mockResolvedValue(undefined);
const loggerInfo = jest.fn();

jest.unstable_mockModule('../../src/models/TransactionReceipt.js', () => ({
    TransactionReceipt: {updateOne: transactionReceiptUpdateOne},
}));

jest.unstable_mockModule('../../src/models/AuditEvent.js', () => ({
    AuditEvent: {updateOne: auditEventUpdateOne},
}));

jest.unstable_mockModule('../../src/services/fraudSignal.service.js', () => ({
    computeAndWriteFraudSignal,
}));

jest.unstable_mockModule('../../src/utils/logger.js', () => ({
    logger: {info: loggerInfo},
}));

const {handleTransferCompleted} = await import('../../src/services/outboxHandlers.js');

const samplePayload = () => ({
    transferId: 'tr-1',
    fromAccountId: 'acc-from',
    toAccountId: 'acc-to',
    fromAccountNumber: 'ACC-111',
    toAccountNumber: 'ACC-222',
    fromUserId: 'user-a',
    toUserId: 'user-b',
    fromUserDisplayName: 'Alice',
    toUserDisplayName: 'Bob',
    amount: '12.50',
    currency: 'USD',
    description: 'Rent',
    ipAddress: '10.0.0.1',
    userAgent: 'jest',
});

describe('handleTransferCompleted', () => {
    beforeEach(() => {
        transactionReceiptUpdateOne.mockClear();
        auditEventUpdateOne.mockClear();
        computeAndWriteFraudSignal.mockClear();
        loggerInfo.mockClear();
    });

    it('writes receipt, debit/credit audit upserts, and fraud signal in parallel', async () => {
        await handleTransferCompleted(samplePayload());

        expect(transactionReceiptUpdateOne).toHaveBeenCalledTimes(1);
        expect(transactionReceiptUpdateOne).toHaveBeenCalledWith(
            {transferId: 'tr-1'},
            expect.objectContaining({
                $setOnInsert: expect.objectContaining({
                    transferId: 'tr-1',
                    fromAccountNumber: 'ACC-111',
                    toAccountNumber: 'ACC-222',
                    amount: '12.50',
                    currency: 'USD',
                    metadata: {ipAddress: '10.0.0.1', userAgent: 'jest'},
                }),
            }),
        );

        expect(auditEventUpdateOne).toHaveBeenCalledTimes(2);

        const debitCall = auditEventUpdateOne.mock.calls.find(
            (c) => c[0].eventType === 'TRANSFER_DEBIT',
        );
        const creditCall = auditEventUpdateOne.mock.calls.find(
            (c) => c[0].eventType === 'TRANSFER_CREDIT',
        );
        expect(debitCall).toBeDefined();
        expect(creditCall).toBeDefined();
        expect(debitCall[1].$setOnInsert.actorId).toBe('user-a');
        expect(creditCall[1].$setOnInsert.actorId).toBe('user-b');
        expect(debitCall[2]).toEqual({upsert: true});

        expect(computeAndWriteFraudSignal).toHaveBeenCalledWith({
            transferId: 'tr-1',
            fromAccountId: 'acc-from',
            toAccountId: 'acc-to',
            fromUserId: 'user-a',
            amount: '12.50',
        });

        expect(loggerInfo).toHaveBeenCalledWith({transferId: 'tr-1'}, expect.any(String));
    });

    it('stores null description and null metadata fields when omitted', async () => {
        const p = samplePayload();
        delete p.description;
        delete p.ipAddress;
        delete p.userAgent;

        await handleTransferCompleted(p);

        const receiptInsert = transactionReceiptUpdateOne.mock.calls[0][1].$setOnInsert;
        expect(receiptInsert.description).toBeNull();
        expect(receiptInsert.metadata).toEqual({ipAddress: null, userAgent: null});
    });
});
