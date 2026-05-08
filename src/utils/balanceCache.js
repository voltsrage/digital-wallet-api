import {redis} from '../db/redis.js';

const BALANCE_TTL_SEC = 30;

export async function getCachedAccount(accountId) {
    const raw = await redis.get(`balance:${accountId}`);
    return raw ? JSON.parse(raw) : null;
}

export async function setCachedAccount(accountId, account){
    await redis.set(`balance:${accountId}`, JSON.stringify(account), 'EX', BALANCE_TTL_SEC);
}

// Called by the transfer service (Phase 5) on every balance-changing write.
// Exported here so the cache key format is defined in one place.
export async function invalidateAccountCache(accountId){
    await redis.del(`balance:${accountId}`);
}