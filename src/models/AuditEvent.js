import mongoose from "mongoose";

/*
    The audit event is the compliance record for every state change in the system. 
    It must be impossible to update or delete from application code — 
    not just by convention, but enforced by the model itself.

    Mongoose middleware hooks run before operations reach the database. 
    A `pre('save')` hook that throws on existing documents prevents any `.save()` 
    call that would update a document. `pre('deleteOne')` and `pre('deleteMany')` 
    hooks prevent removal. After these hooks are in place, 
    any developer who accidentally tries to update or delete 
    an audit event gets an immediate `Error` at the application layer, 
    not a silent data loss.

    **`updatedAt` is excluded intentionally.
    ** An `updatedAt` field on an immutable document is a lie — 
    it would always equal `createdAt` and exists only to suggest the document might be 
    updated. Omitting it removes that ambiguity.
*/
const auditEventSchema = new mongoose.Schema({
    eventType: {type: String, 
        // Explicit enum: unknown event types are a bug, not a valid extension.
      enum: [
        'ACCOUNT_CREATED',
        'ACCOUNT_FROZEN',
        'ACCOUNT_UNFROZEN',
        'ACCOUNT_CLOSED',
        'TRANSFER_COMPLETED',
        'TRANSFER_FAILED',
        'TRANSFER_REVERSED',
        'LOGIN_SUCCESS',
        'LOGIN_FAILED',
        'LOGIN_LOCKED',
        'RECONCILIATION_FAILURE',
      ],
    },
    actorId: {type: String, required: true},   // userId or "system"
    targetId: {type: String, required: true},   // accountId, transferId, or userId
    targetType: {
        type: String,
        required: true,
        enum: ['account', 'transfer', 'user']
    },
    payload: {type: mongoose.Schema.Types.Mixed, required: true}, // full snapshot at event time
    ipAddress: {type: String, default: null},
    userAgent: {type: String, default: null}
},
{
    //updateAt omitted: an immutable document cannot be updated, so the field is meaningless.
    timestamps: {createdAt: true, updatedAt: false}
}
);

// Primary query: all events for a target (account or user), newest first.
// Both fields in the index match the query filter + sort exactly.
auditEventSchema.index({targetId: 1, createdAt: -1});
// Admin query: filter bu event type across all targets
auditEventSchema.index({eventType: 1, createdAt: -1});

// Immutability enforcement - these hooks fire before the database operation.
auditEventSchema.pre('save', async function(){
    if(!this.isNew){
        throw new Error('AuditEvent is immutable and cannot be updated.');
    }
});

// Prevent deletion of individual documents
auditEventSchema.pre('deleteOne', async function(){
    throw new Error('AuditEvent is immutable and cannot be deleted.');
});

// Prevent bulk deletion
auditEventSchema.pre('deleteMany', async function(){
    throw new Error('AuditEvent is immutable and cannot be deleted.');
});

// findOneAndUpdate would bypass the pre('save') hook - block it too.
auditEventSchema.pre('findOneAndUpdate', async function(){
    throw new Error('AuditEvent is immutable and cannot be updated.');
});

auditEventSchema.pre('updateOne', async function(){
    throw new Error('AuditEvent is immutable and cannot be updated.');
});

auditEventSchema.pre('updateMany', async function() {
    throw new Error('AuditEvent is immutable and cannot be updated.');
});

export const AuditEvent = mongoose.model('AuditEvent', auditEventSchema);

