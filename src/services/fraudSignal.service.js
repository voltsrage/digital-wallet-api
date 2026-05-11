import Decimal from "decimal.js";
import {knex} from '../db/knex.js';
import {FraudSignal} from '../models/FraudSignal.js';
import { getTransferVelocity } from "../utils/velocityCheck.js";
import { logger } from "../utils/logger.js";

export async function computeAndWriteFraudSignal({
    transferId,
    fromAccountId,
    toAccountId,
    fromUserId,
    amount
})
{
    const [fromAccount, velocityCount, priorToRecipientCount, recentSenderCount, fromUser] = await Promise.all([
        knex('accounts').where({id: fromAccountId}).select('daily_limit').first(),
        getTransferVelocity(fromUserId),
        knex('transfers')
            .where({from_account_id: fromAccountId, to_account_id: toAccountId})
            .count('id as count')
            .first(),
        // New: how many distinct source accounts have sent to this destination in the last 30 minutes?
        knex('transfers')
            .where('to_account_id', toAccountId)
            .where('status', 'completed')
            .where('created_at', '>=', knex.raw(`NOW() - INTERVAL '30 minutes'`))
            .countDistinct('from_account_id as count')
            .first(),
        knex('users').where({id: fromUserId}).select('password_reset_at').first()
    ]);

    const signals = [];

    // VELOCITY signal: transfers sent in the last 10-minute window.
    if(velocityCount > 5){
        signals.push({
            type: 'VELOCITY',
            severity: velocityCount > 15 ? 'high' : velocityCount > 10 ? 'medium' : 'low',
            detail: {count: velocityCount, window: '10m'}
        })
    }

    // LARGE_AMOUNT signal: transfer amount as a percentage of the daily limit
    if(fromAccount){
        const dailyLimit = new Decimal(fromAccount.daily_limit);
        const transferAmt = new Decimal(amount);

        const pct = transferAmt.div(dailyLimit).times(100).toNumber();

        if(pct >= 80){
            signals.push({
                type: 'LARGE_AMOUNT',
                severity: 'high',
                detail: {amountPctOfDailyLimit: Math.round(pct)}
            });
        } else if(pct >= 50){
            signals.push({
                type: 'LARGE_AMOUNT',
                severity: 'medium',
                detail: {amountPctOfDailyLimit: Math.round(pct)}
            })
        }
    }

    // NEW_RECIPIENT signal: this is the first transfer ever to this destination account.
    // Count includes the current transfer (already committed), so <= 1 means first-ever.
    const priorCount = parseInt(priorToRecipientCount?.count ?? '0', 10);
    if(priorCount <= 1){
        signals.push({
            type: 'NEW_RECIPIENT',
            severity: 'medium',
            detail: {firstTransfer: true}
        })
    }

    // DESTINATION_FUNNEL signal: many distinct senders to the same recipient in 30 minutes
    const senderCount = parseInt(recentSenderCount?.count ?? '0', 10);
    if(senderCount >= 15) {
        signals.push({
            type: 'DESTINATION_FUNNEL',
            severity: 'high',
            detail: {uniqueSendersLast30m: senderCount}
        })
    } else if(senderCount >= 8){
        signals.push({
            type: 'DESTINATION_FUNNEL',
            severity: 'medium',
            detail: {uniqueSendersLast30m: senderCount}
        })
    } else if(senderCount >= 4){
        signals.push({
            type: 'DESTINATION_FUNNEL',
            severity: 'low',
            detail: {uniqueSendersLast30m: senderCount}
        })
    }

    // RECENT_PASSWORD_RESET signal: transfer shortly after a password reset.
    /*
    Combining a recent password reset with an immediate high-value transfer is the clearest account 
    takeover fingerprint. The attacker does not have the victim's original credentials — they used a reset link. 
    The time gap between reset and transfer is measured in minutes, not days. No legitimate user resets their password and then immediately wires money.

    This signal only evaluates once the `password_reset_at` column (Step 1) is being written — it is inert until then.
    Adding it now means the fraud scorer automatically picks up the signal the moment the password reset endpoint 
    is implemented.

    */
    if(fromUser?.password_reset_at){
        const resetAt = new Date(fromUser.password_reset_at);
        const minutesSince = (Date.now() - resetAt.getTime()) / 60_000;

        if(minutesSince <= 10){
            signals.push(
                {
                    type: 'RECENT_PASSWORD_RESET',
                    severity: 'high',
                    detail: {minutesSinceReset: Math.round(minutesSince)}
                }
            )
        } else if(minutesSince <= 60){
            signals.push(
                {
                    type: 'RECENT_PASSWORD_RESET',
                    severity: 'medium',
                    detail: {minutesSinceReset: Math.round(minutesSince)}
                }
            )
        }
    }

    const riskScore = computeRiskScore(signals);
    const decision = computeDecision(riskScore);

    // $setOnInsert ensures idempotency - if the outbox handler runs twice, only one 
    // document is written for this transferId
    await FraudSignal.updateOne(
        {transferId},
        {
            $setOnInsert: {
                transferId,
                userId: fromUserId,
                riskScore,
                decision,
                signals,
                createdAt: new Date()
            }
        }
    )

    logger.info({transferId, riskScore, decision, signals: signals.length}, 'Fraud signal written')
}

/*
Phase 8 collapses risk into three buckets: allow, review, block. 
"Review" means nothing if there is no action tied to it — it is just a label on a MongoDB document. 
With four new signals, scores above 70 are now reachable from combinations that do not warrant an outright block. 
A high-velocity transfer to a new recipient after a password reset should produce a temporary hold, 
not necessarily a permanent block.
*/

function computeRiskScore(signals){
    const weight = {low: 10, medium: 25, high: 40};
    // No cap: 3 high-severity signals = 120, which is distinct from 2 high = 80.
    return signals.reduce((sum, s) => sum + (weight[s.severity] ?? 0), 0);
}

function computeDecision(score){
    if(score >= 100) return 'block';
    if(score >= 65) return 'hold';
    if(score >= 30) return 'review';
    return 'allow';
}