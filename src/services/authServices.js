import bcrypt from 'bcrypt';
import {knex} from '../db/knex.js';
import {AuditEvent} from '../models/AuditEvent.js';
import { ConflictError, UnauthorizedError } from '../errors/AppError';
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

