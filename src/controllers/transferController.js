import * as transferService from '../services/transferService.js';
import {ApiResponse} from '../utils/ApiResponse.js';

export async function initiateTransfer(req, res){
    const {fromAccountId, toAccountId, amount, currency, description, idempotencyKey} = req.body;
    
    const transfer = await initiateTransfer({
        userId: req.user.sub,
        fromAccountId,
        toAccountId,
        amount,
        currency,
        description,
        idempotencyKey,
        ipAddress: req.ip ?? null,
        userAgent: req.headers['user-agent'] ?? null
    });

    res.status(201).json(ApiResponse.created(transfer));
}

export async function getTransfer(req, res){
    const result = await getTransfer(req.user.sub, req.params.id);
    res.json(ApiResponse.success(result));
}