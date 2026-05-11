import {describe, expect, it, jest, beforeEach} from '@jest/globals';

const findOneLean = jest.fn();

jest.unstable_mockModule('../../src/services/transferService.js', () => ({
    initiateTransfer: jest.fn(),
    getTransfer: jest.fn(),
}));

jest.unstable_mockModule('../../src/models/FraudSignal.js', () => ({
    FraudSignal: {
        findOne: jest.fn(() => ({lean: findOneLean})),
    },
}));

jest.unstable_mockModule('../../src/models/TransactionReceipt.js', () => ({
    TransactionReceipt: {findOne: jest.fn(() => ({lean: jest.fn()}))},
}));

const {fraudSignalGetOne} = await import('../../src/controllers/transferController.js');

describe('fraudSignalGetOne', () => {
    const statusJson = jest.fn();
    const res = {
        status: jest.fn().mockReturnValue({json: statusJson}),
        json: jest.fn(),
    };

    beforeEach(() => {
        findOneLean.mockReset();
        statusJson.mockClear();
        res.status.mockClear();
        res.json.mockClear();
        res.status.mockReturnValue({json: statusJson});
    });

    it('returns 404 when no fraud signal exists', async () => {
        findOneLean.mockResolvedValue(null);
        await fraudSignalGetOne({params: {id: 'tr-404'}}, res);
        expect(res.status).toHaveBeenCalledWith(404);
        expect(statusJson).toHaveBeenCalledWith(
            expect.objectContaining({success: false, statusCode: 404}),
        );
    });

    it('returns 200 with signal payload when found', async () => {
        const doc = {transferId: 'tr-1', riskScore: 40, decision: 'allow', signals: []};
        findOneLean.mockResolvedValue(doc);
        await fraudSignalGetOne({params: {id: 'tr-1'}}, res);
        expect(res.json).toHaveBeenCalledWith(
            expect.objectContaining({success: true, data: doc}),
        );
    });
});
