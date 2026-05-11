import {describe, expect, it, jest, beforeEach, afterEach, afterAll} from '@jest/globals';

const runReconciliationMock = jest.fn().mockResolvedValue(undefined);
const loggerInfo = jest.fn();
const loggerWarn = jest.fn();
const loggerError = jest.fn();

const prevIntervalMs = process.env.RECONCILIATION_INTERVAL_MS;
process.env.RECONCILIATION_INTERVAL_MS = '120000';

jest.unstable_mockModule('../../src/services/reconciliationService.js', () => ({
    runReconciliation: runReconciliationMock,
}));

jest.unstable_mockModule('../../src/utils/logger.js', () => ({
    logger: {
        info: loggerInfo,
        warn: loggerWarn,
        error: loggerError,
    },
}));

const {startReconciliationJob} = await import('../../src/services/reconciliationJob.js');

afterAll(() => {
    if (prevIntervalMs === undefined) {
        delete process.env.RECONCILIATION_INTERVAL_MS;
    } else {
        process.env.RECONCILIATION_INTERVAL_MS = prevIntervalMs;
    }
});

describe('startReconciliationJob', () => {
    let setIntervalSpy;

    beforeEach(() => {
        runReconciliationMock.mockReset();
        runReconciliationMock.mockResolvedValue(undefined);
        loggerInfo.mockClear();
        loggerWarn.mockClear();
        loggerError.mockClear();
    });

    afterEach(() => {
        setIntervalSpy?.mockRestore();
    });

    it('schedules the interval and invokes runReconciliation from the callback', async () => {
        let tick;
        setIntervalSpy = jest.spyOn(global, 'setInterval').mockImplementation((fn) => {
            tick = fn;
            return {unref: jest.fn()};
        });

        startReconciliationJob();
        expect(setIntervalSpy).toHaveBeenCalledWith(expect.any(Function), 120_000);
        expect(loggerInfo).toHaveBeenCalledWith({intervalSec: 120}, expect.any(String));

        await tick();
        expect(runReconciliationMock).toHaveBeenCalledTimes(1);
    });

    it('skips when a run is still in progress and logs a warning', async () => {
        let finish;
        runReconciliationMock.mockImplementationOnce(
            () =>
                new Promise((resolve) => {
                    finish = resolve;
                }),
        );

        let tick;
        setIntervalSpy = jest.spyOn(global, 'setInterval').mockImplementation((fn) => {
            tick = fn;
            return {unref: jest.fn()};
        });

        startReconciliationJob();

        const first = tick();
        const second = tick();

        expect(loggerWarn).toHaveBeenCalledWith('Reconciliation job skipped - previous run still in progress');

        finish();
        await first;
        await second;
    });

    it('logs errors from runReconciliation without leaving isRunning stuck', async () => {
        runReconciliationMock.mockRejectedValueOnce(new Error('db unavailable'));

        let tick;
        setIntervalSpy = jest.spyOn(global, 'setInterval').mockImplementation((fn) => {
            tick = fn;
            return {unref: jest.fn()};
        });

        startReconciliationJob();
        await tick();

        expect(loggerError).toHaveBeenCalledWith({err: expect.any(Error)}, expect.any(String));

        await tick();
        expect(runReconciliationMock).toHaveBeenCalledTimes(2);
    });
});
