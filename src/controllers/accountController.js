import * as accountService from '../services/accountService.js';
import {ApiResponse} from '../utils/ApiResponse.js';

export async function createAccount(req, res) {
    const {currency} = req.body;
    const account = await accountService.createAccount(req.user.sub, {currency});
    res.status(201).json(ApiResponse.created(account));
}

export async function listAccounts(req, res){
    const accounts = await accountService.listAccounts(req.user.sub);
    res.json(ApiResponse.success(accounts));
}

export async function  getAccount(req, res) {
    const account = await accountService.getAccount(req.user.sub, req.params.id)
    res.json(ApiResponse.success(account));
}

export async function freezeAccount(req, res){
    const account = await accountService.freezeAccount(req.user.sub, req.params.id);
    res.json(ApiResponse.success(account));
}

export async function unfreezeAccount(req, res){
    const account = await accountService.unfreezeAccount(req.user.sub, req.params.id);
    res.json(ApiResponse.success(account));
}

export async function closeAccount(req, res){
    const account = await accountService.closeAccount(req.user.sub, req.params.id);
    res.json(ApiResponse.success(account));
}

