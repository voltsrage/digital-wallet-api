import {redis} from '../db/redis.js';
import {TooManyRequestsError} from '../errors/AppError.js';

const TRANSFER_COUNT_LIMIT = 20;
const TRANSFER_WINDOW_SEC = 600;

// Fixed-window counter: INCR increments the count, EXPIRE sets the window on the
// first increment. Approximation: a burst at the window boundary can allow up to 
// 2x the limit over two adjacent windows. Acceptable for this scale -  the goal is
// burst protection, not exact rate enforcement

export async function checkTransactionVelocity(userId) {
    const key = `ratelimit:transfer:${userId}`;
    const count = await redis.incr(key);

    // $set expiry only on first increment - subsequent calls leave the existing TTL.
    if(count === 1) await redis.expire(key, TRANSFER_WINDOW_SEC);

    if(count > TRANSFER_COUNT_LIMIT) {
        throw new TooManyRequestsError(
            `Transfer rate limit exceeded. Maximum ${TRANSFER_COUNT_LIMIT} transfers per 10 minutes` , 'TRANSFER_RATE_LIMIT' 
        )
    }

    // Return the current count so the fraud scorer can read it without a second Redis call.
    return count;
}

// Read-only: used bu the fraud scorer to get the current velocity without incrementing
export async function getTransferVelocity(userId){
    const count = await redis.get(`ratelimit:transfer:${userId}`);
    return parseInt(count ?? '0', 10);
}