import {TransactionReceipt} from '../models/TransactionReceipt.js';
import {AuditEvent} from '../models/AuditEvent.js';
import {logger} from '../utils/logger.js';

export async function handleTransferCompleted(payload){
    const {
        transferId,
        fromAccountId,
        toAccountId,
        fromAccountNumber,
        toAccountNumber,
        fromUserId,
        toUserId,
        fromUserDisplayName,
        toUserDisplayName,
        amount,
        currency,
        description,
        ipAddress,
        userAgent
    } = payload;

    // Write the receipt and both audit events in parallel - they are independent documents.
    await Promise.all([
        writeReceipt({
            transferId, fromAccountNumber, toAccountNumber, fromUserDisplayName, toUserDisplayName, amount, currency, description, ipAddress, userAgent
        }),
        writeAuditEvent({
            eventType: 'TRANSFER_DEBIT',
            actorId: fromUserId,
            targetId: fromAccountId,
            targetType: 'account',
            payload: {transferId, amount, currency, toAccountId, description},
            ipAddress, 
            userAgent
        }),
        writeAuditEvent({
            eventType: 'TRANSFER_CREDIT',
            actorId: toUserId,
            targetId: toAccountId,
            targetType: 'account',
            payload: {transferId, amount, currency, toAccountId, description},
            ipAddress, 
            userAgent
        })
    ]);

    logger.info({transferId}, 'MongoDB writes completed for TRANSFER COMPLETED');
}

async function writeReceipt({transferId, fromAccountNumber, toAccountNumber, fromUserDisplayName, toUserDisplayName, amount, currency, description, ipAddress, userAgent}){
    // $setOnInsert means: if a document with this transferId already exists, do nothing
    // If is does not exit, insert the full document.
    // This makes the write idempotent - running it twice has the same effect as running it once

    await TransactionReceipt.updateOne({transferId}, {
        $setOnInsert : {
            transferId,
            fromAccountNumber,
            toAccountNumber,
            fromUserDisplayName,
            toUserDisplayName,
            amount,
            currency,
            description: description ?? null,
            metadata: {
                ipAddress: ipAddress ?? null,
                userAgent: userAgent ?? null
            },
            createdAt: new Date()
        }
    })
}

async function writeAuditEvent({eventType, actorId, targetId, targetType, payload, ipAddress, userAgent}){
    // Audit events are append-only. Use upsert keyed on (eventType + targetId + payload.transferId)
    // so that a duplicate poller run does not insert a second document
    await AuditEvent.updateOne(
        {
            eventType,
            targetId,
            'payload.transferId': payload.transferId
        },
        {
            $setOnInsert: {
                eventType,
                actorId: actorId ?? 'system',
                targetId,
                targetType,
                payload,
                ipAddress: ipAddress ?? null,
                userAgent: userAgent ?? null,
                createdAt: new Date()
            }
        },
        {
            upsert: true
        }
    )
}