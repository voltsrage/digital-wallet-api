import bcrypt from 'bcrypt';
import {knex} from '../db/knex.js';
import {AuditEvent} from '../models/AuditEvent.js';
import { ConflictError, UnauthorizedError } from '../errors/AppError.js';
import {
    signAccessToken,
    issueRefreshToken,
    validateRefreshToken,
    revokeRefreshToken
}
from '../utils/tokens.js';

const BCRYPT_ROUNDS = 12;
const MAX_FAILURES = 10;
const LOCKOUT_MINUTES = 30;

const userColumns = {
    id: 'id',
    email: 'email',
    status: 'status',
    createdAt: 'created_at',
    displayName:'display_name',
    failedLoginCount: 'failed_login_count',
    lockedUntil: 'locked_until',
    passwordHash: 'password_hash'
}

export async function register({email, password, displayName}){
    const existing = await knex('users').where({email}).first();
    if(existing) throw new ConflictError('Email is already registered.', 'EMAIL_TAKEN');

    const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);

    const [user] = await knex('users')
        .insert({email, password_hash: passwordHash, display_name : displayName ?? null})
        .returning(['id','email', 'display_name', 'status', 'created_at']);

    const accessToken = signAccessToken(user.id)
    const refreshToken = await issueRefreshToken(user.id);

    return {user: toPublicUser(user), accessToken, refreshToken};
}

export async function login({email, password, ipAddress, userAgent}){
    const user = await knex('users')
        .where({email})
        .select(
            userColumns.id, 
            userColumns.email, 
            userColumns.displayName, 
            userColumns.status, 
            userColumns.passwordHash, 
            userColumns.failedLoginCount, 
            userColumns.lockedUntil)
        .first();

    // Same message for not-found and wrong password - prevents enumeration
    if(!user) throw new UnauthorizedError('Invalid email or password');

    if(user.status === 'suspended')
        throw new UnauthorizedError('Invalid email or password');

    // locked_until is a TIMESTAMPZ - compare as Date, not string
    if(user.locked_until && new Date(user.locked_until) > new Date())
        throw new UnauthorizedError('Invalid email or password');

    const valid = await bcrypt.compare(password, user.password_hash);
    
    if(!valid){
        // Atomic increment + conditional lock in a single UPDATE.
        // The CASE reads failed_login_count + 1 (post-increment), so the decision to
        // lock is made by the database after the write — no race window between read and write.

        const [updated] = await knex('users')
            .where({id: user.id})
            .update({
                failed_login_count: knex.raw('failed_login_count + 1'),
                locked_until: knex.raw(`
                    CASE
                        WHEN failed_login_count + 1 >= ?
                        THEN NOW() + INTERVAL '${LOCKOUT_MINUTES} minutes'
                        ELSE locked_until
                    END
                `, [MAX_FAILURES]),
                updated_at: knex.fn.now()
            })
            .returning([userColumns.failedLoginCount, userColumns.lockedUntil])

        await AuditEvent.create({
            eventType: 'LOGIN_FAILED',
            actorId: user.id,
            targetId: user.id,
            targetType: 'user',
            payload: {reason: 'wrong_password', failureCount: updated.failed_login_count},
            ipAddress,
            userAgent
        });

        if(updated.failed_login_count >= MAX_FAILURES){
            await AuditEvent.create({
                eventType: 'LOGIN_LOCKED',
                actorId: user.id,
                targetId: user.id,
                targetType: 'user',
                payload: {lockedUntil: updated.locked_until, failureCount: updated.failed_login_count},
                ipAddress,
                userAgent
            }); 
        }

        throw new UnauthorizedError('Invalid email or password');
    }

    // Successful login - reset lockout state
    await knex('users').where({id: user.id}).update({
        failed_login_count: 0,
        locked_until: null,
        updated_at: knex.fn.now()
    });

    await AuditEvent.create({
        eventType: 'LOGIN_SUCCESS',
        actorId: user.id,
        targetId: user.id,
        targetType: 'user',
        payload: {email: user.email},
        ipAddress,
        userAgent
    }); 

    const accessToken = signAccessToken(user.id);
    const refreshToken = await issueRefreshToken(user.id);

    return {user: toPublicUser(user), accessToken, refreshToken};
}

export async function refresh(token){
    const result = await validateRefreshToken(token);
    if(!result) throw new UnauthorizedError('Invalid or expired refresh token');

    // Rotate: delete old token before issuing new on - stolen cannot be reused
    await revokeRefreshToken(result.userId, result.tokenId);

    const user = await knex('users')
    .where({id: result.userId})
    .select(userColumns.id, userColumns.email, userColumns.displayName, userColumns.status)
    .first();

    if(!user || user.status === 'suspended')
        throw new UnauthorizedError('Invalid or expired refresh token');

    const accessToken = signAccessToken(user.id);
    const refreshToken = await issueRefreshToken(user.id);

    return {accessToken, refreshToken};
}

export async function logout(token){
    const result = await validateRefreshToken(token);
    // Already valid - treat as success. Returning an error here would break clients
    // that retry logout on network failure

    if(!result) return;

    await revokeRefreshToken(result.userId, result.tokenId);
}

function toPublicUser(user) {
    return {
        id:          user.id,
        email:       user.email,
        displayName: user.display_name,
        createdAt:   user.created_at,
    };
}