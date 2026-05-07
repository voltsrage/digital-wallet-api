import mongoose  from "mongoose";

const transactionReceiptSchema = new mongoose.Schema(
    {
        // transferId matches the PostgreSQL transfers.id — the link between the two databases.
        // The unique index enables idempotent upsert in Phase 6: if the outbox poller processes
        // the same event twice, the second write is a no-op.
        transferId: {type: String, required: true},
        fromAccountNumber: {type: String, required: true},  // denormalized at write time
        toAccountNumber: {type: String, required: true},  // denormalized at write time
        fromUserDisplayName: {type: String, required: true},  // denormalized at write time
        toUserDisplayName: {type: String, required: true},  // denormalized at write time
        amount: {type: mongoose.Schema.Types.Decimal128, required: true},
        currency: {type: String, required:true, default: 'USD'},
        description: {type:String, default: null},
        // Mixed: no schema enforcement on nested fields. New metadata fields can be added
        // without a migration — the flexibility is the feature.
        metadata: {
            type: mongoose.Schema.Types.Mixed,
            default: {}
        },
        tags: [{type: String}]
    },
    {timestamps: {createdAt: true, updatedAt: false}}    
);

// Unique on transferId: one receipt per transfer. Combined with the Phase 6 upsert
// pattern ({ $setOnInsert: payload }, { upsert: true }), duplicate outbox events
// produce no duplicate documents.

transactionReceiptSchema.index({transferId: 1}, {unique: true});

export const TransactionReceipt = mongoose.model('TransactionReceipt', transactionReceiptSchema);