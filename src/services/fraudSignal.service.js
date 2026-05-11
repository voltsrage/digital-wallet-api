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
    const [fromAccount, velocityCount, priorToRecipientCount] = await Promise.all([
        knex('accounts').where({id: fromAccountId}).select('daily_limit').first(),
        getTransferVelocity(fromUserId),
        knex('transfers')
            .where({from_account_id: fromAccountId, to_account_id: toAccountId})
            .count('id as count')
            .first()
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

function computeRiskScore(signals){
    const weight = {low: 10, medium: 25, high: 40};
    const raw = signals.reduce((sum, s) => sum + (weight[s.severity] ?? 0), 0);
    return Math.min(raw, 100);
}

function computeDecision(score){
    if(score >= 70) return 'block';
    if(score >= 30) return 'review';
    return 'allow';
}