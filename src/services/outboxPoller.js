import {knex} from '../db/knex.js';
import {logger} from '../utils/logger.js';
import {handleTransferCompleted} from './outboxHandlers.js';

const POLL_INTERVAL_MS = 5_000;
const BATCH_SIZE = 50;

const handlers = {
    TRANSFER_COMPLETED: handleTransferCompleted
}

export function startOutboxPoller(){
    const interval = setInterval(pollOnce, POLL_INTERVAL_MS);

    // Allow Node to exit cleanly - the poller should not prevent shutdown
    interval.unref();

    logger.info('Outbox poller started');

    return interval;
}

async function pollOnce(){
    try{
        await knex.transaction(async (trx) => {
            // FOR UPDATE SKIP LOCKED: atomically lock this batch and skip any ros
            // already locked by another poller instance. Each row is processed by
            // exactly one worker even if multiple pollers run concurrently

            const events = await trx.raw(`
                SELECT id, event_type, payload
                FROM outbox_events
                WHERE processed = false
                ORDER BY created_at
                LIMIT :limit
                FOR UPDATE SKIP LOCKED
                `, {limit: BATCH_SIZE});

            const rows = events.rows;
            if(rows.length === 0) return;

            for(const row of rows){
                const handler = handlers[row.event_type];

                if(!handler){
                    logger.warn({eventType: row.event_type, eventId: row.id}, 'No handler for outbox event type');

                    // Mark unknown events processed so they do not block the queue.
                    await trx('outbox_events').where({id: row.id}).update({processed: true});
                    continue;
                }

                const payload = typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload;

                await handler(payload);

                await trx('outbox_events').where({id: row.id}).update({processed: true});
            }

            logger.info({count: rows.length}, 'Outbox batch processed');
        })
    } catch(err) {
        // Log and swallow - the poller must not crash the process on a transient failure
        // The unprocessed events remain in the table and will be retried on the next tick
        logger.error({err}, 'Outbox poller tick failed');
    }
}