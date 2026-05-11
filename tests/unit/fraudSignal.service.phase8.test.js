import {describe, expect, it, jest, beforeEach} from '@jest/globals';

const getTransferVelocity = jest.fn();

jest.unstable_mockModule('../../src/utils/velocityCheck.js', () => ({
    getTransferVelocity,
}));

jest.unstable_mockModule('../../src/models/FraudSignal.js', () => ({
    FraudSignal: {updateOne: jest.fn().mockResolvedValue({})},
}));

jest.unstable_mockModule('../../src/utils/logger.js', () => ({
    logger: {info: jest.fn()},
}));

/** @type {{ dailyLimit: string; priorCount: string; funnelCount: string; passwordResetAt: Date | null }} */
const fraudKnexState = {
    dailyLimit: '10000',
    priorCount: '2',
    funnelCount: '0',
    passwordResetAt: null,
};

function fraudKnexTable(table) {
    if (table === 'accounts') {
        return {
            where: jest.fn().mockReturnThis(),
            select: jest.fn().mockReturnThis(),
            first: jest.fn().mockResolvedValue({daily_limit: fraudKnexState.dailyLimit}),
        };
    }
    if (table === 'transfers') {
        return {
            where: jest.fn().mockReturnThis(),
            join: jest.fn().mockReturnThis(),
            count: jest.fn().mockReturnValue({
                first: jest.fn().mockResolvedValue({count: fraudKnexState.priorCount}),
            }),
            countDistinct: jest.fn().mockReturnValue({
                first: jest.fn().mockResolvedValue({count: fraudKnexState.funnelCount}),
            }),
        };
    }
    if (table === 'users') {
        return {
            where: jest.fn().mockReturnThis(),
            select: jest.fn().mockReturnThis(),
            first: jest.fn().mockResolvedValue(
                fraudKnexState.passwordResetAt
                    ? {password_reset_at: fraudKnexState.passwordResetAt}
                    : {},
            ),
        };
    }
    throw new Error(`Unexpected table: ${table}`);
}

const knexFn = jest.fn((table) => fraudKnexTable(table));
knexFn.raw = jest.fn(() => ({}));

jest.unstable_mockModule('../../src/db/knex.js', () => ({
    knex: knexFn,
}));

const {computeAndWriteFraudSignal} = await import('../../src/services/fraudSignal.service.js');
const {FraudSignal} = await import('../../src/models/FraudSignal.js');

const baseArgs = () => ({
    transferId: 'tr-fraud-1',
    fromAccountId: 'acc-from',
    toAccountId: 'acc-to',
    fromUserId: 'user-sender',
    amount: '5000.00',
});

describe('computeAndWriteFraudSignal', () => {
    beforeEach(() => {
        FraudSignal.updateOne.mockClear();
        getTransferVelocity.mockReset();
        fraudKnexState.dailyLimit = '10000';
        fraudKnexState.priorCount = '2';
        fraudKnexState.funnelCount = '0';
        fraudKnexState.passwordResetAt = null;
    });

    it('writes allow when only low-risk signals are absent above thresholds', async () => {
        getTransferVelocity.mockResolvedValue(3);

        await computeAndWriteFraudSignal({
            ...baseArgs(),
            amount: '1.00',
        });

        expect(FraudSignal.updateOne).toHaveBeenCalledWith(
            {transferId: 'tr-fraud-1'},
            expect.objectContaining({
                $setOnInsert: expect.objectContaining({
                    decision: 'allow',
                    riskScore: 0,
                    signals: [],
                }),
            }),
        );
    });

    it('adds VELOCITY low / medium / high from transfer count', async () => {
        getTransferVelocity.mockResolvedValueOnce(6);
        await computeAndWriteFraudSignal(baseArgs());
        let insert = FraudSignal.updateOne.mock.calls[0][1].$setOnInsert;
        expect(insert.signals.some((s) => s.type === 'VELOCITY' && s.severity === 'low')).toBe(true);

        getTransferVelocity.mockResolvedValueOnce(12);
        await computeAndWriteFraudSignal({...baseArgs(), transferId: 'tr-2'});
        insert = FraudSignal.updateOne.mock.calls[1][1].$setOnInsert;
        expect(insert.signals.find((s) => s.type === 'VELOCITY').severity).toBe('medium');

        getTransferVelocity.mockResolvedValueOnce(16);
        await computeAndWriteFraudSignal({...baseArgs(), transferId: 'tr-3'});
        insert = FraudSignal.updateOne.mock.calls[2][1].$setOnInsert;
        expect(insert.signals.find((s) => s.type === 'VELOCITY').severity).toBe('high');
    });

    it('adds LARGE_AMOUNT medium and high from % of daily limit', async () => {
        getTransferVelocity.mockResolvedValue(0);
        fraudKnexState.dailyLimit = '100';
        await computeAndWriteFraudSignal({...baseArgs(), amount: '55'});
        let insert = FraudSignal.updateOne.mock.calls[0][1].$setOnInsert;
        expect(insert.signals.find((s) => s.type === 'LARGE_AMOUNT').severity).toBe('medium');

        await computeAndWriteFraudSignal({...baseArgs(), transferId: 'tr-big', amount: '85'});
        insert = FraudSignal.updateOne.mock.calls[1][1].$setOnInsert;
        expect(insert.signals.find((s) => s.type === 'LARGE_AMOUNT').severity).toBe('high');
    });

    it('adds NEW_RECIPIENT when prior transfer count is at most 1', async () => {
        getTransferVelocity.mockResolvedValue(0);
        fraudKnexState.priorCount = '1';
        await computeAndWriteFraudSignal(baseArgs());
        const insert = FraudSignal.updateOne.mock.calls[0][1].$setOnInsert;
        expect(insert.signals.some((s) => s.type === 'NEW_RECIPIENT')).toBe(true);
    });

    it('adds DESTINATION_FUNNEL low / medium / high tiers', async () => {
        getTransferVelocity.mockResolvedValue(0);
        fraudKnexState.funnelCount = '4';
        await computeAndWriteFraudSignal({...baseArgs(), transferId: 't-f1'});
        expect(
            FraudSignal.updateOne.mock.calls[0][1].$setOnInsert.signals.find((s) => s.type === 'DESTINATION_FUNNEL')
                .severity,
        ).toBe('low');

        fraudKnexState.funnelCount = '9';
        await computeAndWriteFraudSignal({...baseArgs(), transferId: 't-f2'});
        expect(
            FraudSignal.updateOne.mock.calls[1][1].$setOnInsert.signals.find((s) => s.type === 'DESTINATION_FUNNEL')
                .severity,
        ).toBe('medium');

        fraudKnexState.funnelCount = '16';
        await computeAndWriteFraudSignal({...baseArgs(), transferId: 't-f3'});
        expect(
            FraudSignal.updateOne.mock.calls[2][1].$setOnInsert.signals.find((s) => s.type === 'DESTINATION_FUNNEL')
                .severity,
        ).toBe('high');
    });

    it('adds RECENT_PASSWORD_RESET high within 10 minutes and medium within 60', async () => {
        getTransferVelocity.mockResolvedValue(0);
        fraudKnexState.passwordResetAt = new Date(Date.now() - 3 * 60 * 1000);
        await computeAndWriteFraudSignal({...baseArgs(), transferId: 't-pw1'});
        expect(
            FraudSignal.updateOne.mock.calls[0][1].$setOnInsert.signals.find((s) => s.type === 'RECENT_PASSWORD_RESET')
                .severity,
        ).toBe('high');

        fraudKnexState.passwordResetAt = new Date(Date.now() - 30 * 60 * 1000);
        await computeAndWriteFraudSignal({...baseArgs(), transferId: 't-pw2'});
        expect(
            FraudSignal.updateOne.mock.calls[1][1].$setOnInsert.signals.find((s) => s.type === 'RECENT_PASSWORD_RESET')
                .severity,
        ).toBe('medium');
    });

    it('maps risk score to review / hold / block thresholds', async () => {
        getTransferVelocity.mockResolvedValue(0);
        fraudKnexState.priorCount = '1';
        fraudKnexState.dailyLimit = '100';
        await computeAndWriteFraudSignal({...baseArgs(), amount: '60'});
        expect(FraudSignal.updateOne.mock.calls[0][1].$setOnInsert.decision).toBe('review');

        fraudKnexState.priorCount = '2';
        getTransferVelocity.mockResolvedValue(11);
        fraudKnexState.dailyLimit = '100';
        await computeAndWriteFraudSignal({...baseArgs(), transferId: 't-hold', amount: '85'});
        expect(FraudSignal.updateOne.mock.calls[1][1].$setOnInsert.decision).toBe('hold');

        getTransferVelocity.mockResolvedValue(16);
        fraudKnexState.priorCount = '1';
        fraudKnexState.dailyLimit = '100';
        await computeAndWriteFraudSignal({...baseArgs(), transferId: 't-block', amount: '90'});
        expect(FraudSignal.updateOne.mock.calls[2][1].$setOnInsert.decision).toBe('block');
    });
});
