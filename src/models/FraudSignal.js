import mongoose from "mongoose";

const fraudSignalSchema = new mongoose.Schema(
    {
        transferId: {type: String, required: true},
        userId: {type: String, required: true},
        riskScore: {type: Number, required: true, min: 0, max: 100},
        decision: {
            type: String,
            required: true,
            enum: ['allow', 'review', 'block']
        },
        // Each element has: type (string), severity (string), detail (Mixed).
        // detail varies by type — no fixed sub-schema is correct here.
        signals: [
            {
                type: {type: String, required: true},
                severity: {type: String, enum: ['low', 'medium', 'high'], required: true},
                detail: {type: mongoose.Schema.Types.Mixed, default: {}}
            }
        ]
    },
    {
        timestamps: {createdAt: true, updatedAt: false}
    }
)

// One fraud signal per transfer. Same upsert pattern as TransactionReceipt in Phase 6.
fraudSignalSchema.index({transferId: 1}, {unique: true});
// Query pattern: all fraud signals for a user, for risk review.
fraudSignalSchema.index({userId: 1, createdAt: -1});

export const FraudSignal = mongoose.model('FraudSignal', fraudSignalSchema);