import { runReconciliation } from "./reconciliationService.js";
import { logger } from "../utils/logger.js";

// Production default: once per day (86400s)
// Development override: RECONCILIATION_INTERVAL_MS=60000 runs every minute
const INTERVAL_MS = parseInt(process.env.RECONCILIATION_INTERVAL_MS ?? '86400000', 10);

let isRunning = false;

export function startReconciliationJob() {
    // setInterval fires after the first interval - the job dos not run at startup.
    // This avoids running during the deployment window and ensures the day's
    // transfers are settled before the first check
    const interval = setInterval(async () => {
        if(isRunning){
            logger.warn('Reconciliation job skipped - previous run still in progress');
            return;
        }

        isRunning = true;

        try{
            await runReconciliation();
        }
        catch(err){
            logger.error({err}, 'Reconciliation job encounter an unhandled error');
        }
        finally {
            isRunning = false;
        }
    }, INTERVAL_MS);

    interval.unref();

    const intervalSec = INTERVAL_MS / 1000;
    logger.info({intervalSec}, 'Reconciliation job scheduled');

    return interval;
}