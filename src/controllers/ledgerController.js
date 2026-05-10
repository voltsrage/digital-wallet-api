import * as ledgerService from '../services/ledgerService.js';
import {ApiResponse} from '../utils/ApiResponse.js';

export async function getLedger(req, res){
    const result = await ledgerService.getLedger(req.user.sub, req.params.id, req.query);

    res.json(ApiResponse.success(result));
}

export async function getAccountSummary(req, res){
    const result = await getAccountSummary(req.user.sub, req.params.id, req.query);

    res.json(ApiResponse.success(result));
}