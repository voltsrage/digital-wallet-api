import {redis} from '../db/redis.js';
import {knex} from '../db/knex.js';
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

/*
    Phase 1 added `failed_login_count` and `locked_until` to the `users` table. 
    That counter is per-account: 10 failures on one account triggers a 30-minute lock. 
    It catches a targeted brute force attack on a known email address.

    It does not catch credential stuffing. A stuffing attack tries thousands of `email:password` pairs,
    each pair once or twice, across thousands of different accounts. No single account ever hits the 10-failure threshold. 
    The attack succeeds while generating no signal.

    IP velocity catches this. One IP producing 10 failed logins in 5 minutes — across any accounts — 
    is anomalous regardless of which accounts were targeted.
*/
const FAILED_LOGIN_IP_LIMIT = 10;
const FAILED_LOGIN_IP_WINDOW = 300;

// Called after a failed password check. Increments the IP failure counter.
// Returns the current count so callers can decide whether to also lock the account
export async function recordFailedLoginIp(ip){
    if(!ip) return 0;

    const key = `velocity:failed-login:ip:${ip}`;
    const count = await redis.incr(key);
    if(count === 1) await redis.expire(key, FAILED_LOGIN_IP_WINDOW);

    return count;
}

// Called at the start of every login attempt. Throws 429 before the
// password comparison so the attacker cannot use timing to infer validity
export async function checkFailedLoginIpVelocity(ip){
    if(!ip) return;
    const count = parseInt(await redis.get(`velocity:failed-login:ip:${ip}`) ?? 0, 10);
    if(count >= FAILED_LOGIN_IP_LIMIT) {
        throw new TooManyRequestsError(
            'Too many failed login attempts from this IP. Try again later',
            'LOGIN_RATE_LIMIT'
        )
    }
}

const NEW_BENEFICIARY_LIMIT = 3;
const NEW_BENEFICIARY_WINDOW = 600; //10 minutes

// Call this in initiateTransfer before withSerializableRetry.
// If toAccountId is a new recipient for this user, increments the new-beneficiary
// counter and throws 429 if the limit is exceeded.
// If the recipient is already known (prior successful transfer exists), this is a no-op
export async function checkNewBeneficiaryVelocity(userId, toAccountId){
    // Count prior completed transfers from this user to this recipient.
    // Uses the transfers table - only COMPLETED transfers count as 'known' recipients
    const prior = await knex('transfers')
        .join('accounts as from_acc', 'transfers.from_account_id', 'from_acc.id')
        .where('from_acc.user_id', userId)
        .where('transfers.to_account_id', toAccountId)
        .where('transfers.status', 'completed')
        .count('transfers.id as count')
        .first();

    const isNew = parseInt(prior?.count ?? '0', 10) === 0;
    if(!isNew) return; // known recipient - no check needed

    const key = `velocity:new-beneficiary:${userId}`;
    const count = await redis.incr(key);
    if(count === 1) await redis.expire(key, NEW_BENEFICIARY_WINDOW);

    if(count > NEW_BENEFICIARY_LIMIT) {
        throw new TooManyRequestsError(
            `Too many new recipients. Maximum ${NEW_BENEFICIARY_LIMIT} new recipients per 10 minutes.`,
            'NEW_BENEFICIARY_RATE_LIMIT',
        );
    }
}