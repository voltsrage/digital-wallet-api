import {v4 as uuidv4} from 'uuid';

export function correlationId(req, res, next){
    const id = req.headers['x-correlation-id'] || uuidv4();
    req.correlationId = id;
    req.log = req.log.child({correlationId: id});
    req.setHeader('x-correlation-id', id);
    next();
}