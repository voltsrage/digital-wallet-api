import {knex} from '../db/knex.js';
import {ForbiddenError} from '../errors/AppError.js';

/*
This does one extra DB query per admin request. At the rate admin endpoints are called, this is acceptable. An alternative — embedding `role` in the JWT — means role changes require the user to log out and back in. For a security-sensitive role like admin, that is a bad trade.
*/
export async function requireAdmin(req, res, next){
    const user = await knex('users')
        .where({id: req.user.sub})
        .select('role')
        .first();
    
    if(!user || user.role !== 'admin'){
        throw new ForbiddenError('Admin access required', 'FORBIDDEN');
    }

    next();
}