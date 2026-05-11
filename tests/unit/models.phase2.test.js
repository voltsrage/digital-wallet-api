import {describe, expect, it, beforeAll, afterAll} from '@jest/globals';
import mongoose from 'mongoose';
import {AuditEvent} from '../../src/models/AuditEvent.js';
import {TransactionReceipt} from '../../src/models/TransactionReceipt.js';
import {FraudSignal} from '../../src/models/FraudSignal.js';

const mongoUri = process.env.MONGO_TEST_URI;

function validAuditPayload() {
    return {
        eventType: 'LOGIN_SUCCESS',
        actorId: 'user-1',
        targetId: 'user-1',
        targetType: 'user',
        payload: {email: 'a@a.com'},
    };
}

describe('Phase 2 — Mongoose model validation (offline)', () => {
    it('AuditEvent rejects unknown eventType', () => {
        const doc = new AuditEvent({...validAuditPayload(), eventType: 'UNKNOWN_EVENT'});
        const err = doc.validateSync();
        expect(err).toBeDefined();
        expect(err.errors.eventType).toBeDefined();
    });

    it('AuditEvent accepts a valid LOGIN_SUCCESS document', () => {
        const doc = new AuditEvent(validAuditPayload());
        expect(doc.validateSync()).toBeUndefined();
    });

    it('TransactionReceipt rejects missing required fields', () => {
        const doc = new TransactionReceipt({});
        const err = doc.validateSync();
        expect(err).toBeDefined();
        expect(Object.keys(err.errors).length).toBeGreaterThan(0);
    });

    it('TransactionReceipt accepts a minimal valid document', () => {
        const doc = new TransactionReceipt({
            transferId: 't-1',
            fromAccountNumber: 'ACC-00000001',
            toAccountNumber: 'ACC-00000002',
            fromUserDisplayName: 'A',
            toUserDisplayName: 'B',
            amount: mongoose.Types.Decimal128.fromString('10.50'),
            currency: 'USD',
        });
        expect(doc.validateSync()).toBeUndefined();
    });

    it('FraudSignal rejects invalid decision enum', () => {
        const doc = new FraudSignal({
            transferId: 't-1',
            userId: 'u-1',
            riskScore: 10,
            decision: 'maybe',
            signals: [],
        });
        const err = doc.validateSync();
        expect(err).toBeDefined();
        expect(err.errors.decision).toBeDefined();
    });

    it('FraudSignal rejects riskScore above schema max', () => {
        const doc = new FraudSignal({
            transferId: 't-1',
            userId: 'u-1',
            riskScore: 101,
            decision: 'allow',
            signals: [],
        });
        const err = doc.validateSync();
        expect(err).toBeDefined();
        expect(err.errors.riskScore).toBeDefined();
    });

    it('FraudSignal rejects signal severity outside enum', () => {
        const doc = new FraudSignal({
            transferId: 't-1',
            userId: 'u-1',
            riskScore: 0,
            decision: 'allow',
            signals: [{type: 'X', severity: 'critical', detail: {}}],
        });
        const err = doc.validateSync();
        expect(err).toBeDefined();
    });

    it('FraudSignal accepts allow with empty signals', () => {
        const doc = new FraudSignal({
            transferId: 't-1',
            userId: 'u-1',
            riskScore: 0,
            decision: 'allow',
            signals: [],
        });
        expect(doc.validateSync()).toBeUndefined();
    });
});

(mongoUri ? describe : describe.skip)('Phase 2 — AuditEvent immutability (set MONGO_TEST_URI)', () => {
    beforeAll(async () => {
        await mongoose.connect(mongoUri);
        await AuditEvent.deleteMany({targetId: /^jest-immut-/});
    });

    afterAll(async () => {
        await AuditEvent.deleteMany({targetId: /^jest-immut-/});
        await mongoose.disconnect();
    });

    it('throws when saving an existing document after mutation', async () => {
        const targetId = `jest-immut-${Date.now()}`;
        const created = await AuditEvent.create({
            ...validAuditPayload(),
            targetId,
            payload: {email: 'first'},
        });

        created.set('payload', {email: 'tampered'});
        await expect(created.save()).rejects.toThrow(/immutable/i);
    });

    it('throws on deleteOne', async () => {
        const targetId = `jest-immut-${Date.now()}-del`;
        await AuditEvent.create({
            ...validAuditPayload(),
            targetId,
        });

        await expect(AuditEvent.deleteOne({targetId})).rejects.toThrow(/immutable/i);
    });

    it('throws on updateOne', async () => {
        const targetId = `jest-immut-${Date.now()}-upd`;
        await AuditEvent.create({
            ...validAuditPayload(),
            targetId,
        });

        await expect(
            AuditEvent.updateOne({targetId}, {$set: {actorId: 'other'}})
        ).rejects.toThrow(/immutable/i);
    });
});
