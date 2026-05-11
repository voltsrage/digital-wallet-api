import * as transferService from '../services/transferService.js';
import {ApiResponse} from '../utils/ApiResponse.js';
import { FraudSignal } from "../models/FraudSignal.js";
import {TransactionReceipt} from '../models/TransactionReceipt.js';

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
    const result = await transferService.getTransfer(req.user.sub, req.params.id);
    res.json(ApiResponse.success(result));
}

export async function fraudSignalGetOne(req, res){
    const signal = await FraudSignal.findOne({transferId: req.params.id}).lean();
    if(!signal)
        return res.status(404).json(ApiResponse.error('Fraud signal not found.', 'NOT_FOUND', 404));

    res.json(ApiResponse.success(signal));
}

export async function getTransactionReceipt(req, res){
    // Verify the requesting user is a party to the transfer (reuse existing service)
    await transferService.getTransfer(req.user.sub, req.params.id); // throws Forbidden / NotFoundError if not authorized

    const receipt = await TransactionReceipt.findOne({transferId: req.params.id}).lean();
    if(!receipt)
        return res.status(404).json(ApiResponse.error('Receipt not found', 'NOT_FOUND', 404));

    res.json(ApiResponse.success(receipt));
}