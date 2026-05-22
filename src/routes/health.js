import express from 'express';
import mongoose from 'mongoose';
import { knex } from '../db/knex.js';
import { redis } from '../db/redis.js';

export const healthRouter = express.Router();

export async function liveness(_req, res) {
    res.json({ status: 'ok' });
}

export async function readiness(_req, res) {
    const checks = {};
    let healthy = true;

    try {
        await knex.raw('SELECT 1');
        checks.postgres = 'ok';
    } catch {
        checks.postgres = 'error';
        healthy = false;
    }

    try {
        if (mongoose.connection.readyState !== 1) throw new Error('not connected');
        checks.mongo = 'ok';
    } catch {
        checks.mongo = 'error';
        healthy = false;
    }

    try {
        await redis.ping();
        checks.redis = 'ok';
    } catch {
        checks.redis = 'error';
        healthy = false;
    }

    res.status(healthy ? 200 : 503).json({ status: healthy ? 'ok' : 'degraded', checks });
}

healthRouter.get('/', liveness);
healthRouter.get('/ready', readiness);
