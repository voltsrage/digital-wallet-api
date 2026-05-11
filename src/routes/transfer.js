import { Router } from "express";
import * as transferController from '../controllers/transferController.js';
import {authenticate} from '../middleware/authenticate.js';
import { requireAdmin } from "../middleware/requireAdmin.js";

export const transfersRouter = Router();

transfersRouter.use(authenticate);

/**
 * @openapi
 * /transfers:
 *   post:
 *     summary: Initiate a transfer
 *     tags: [Transfers]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [fromAccountId, toAccountId, amount, currency, idempotencyKey]
 *             properties:
 *               fromAccountId:  { type: string, format: uuid }
 *               toAccountId:    { type: string, format: uuid }
 *               amount:         { type: string, example: "50.00" }
 *               currency:       { type: string, example: "USD" }
 *               description:    { type: string }
 *               idempotencyKey: { type: string, format: uuid }
 *     responses:
 *       201:
 *         description: Transfer completed
 */
transfersRouter.post('/', transferController.initiateTransfer);

/**
 * @openapi
 * /transfers/{id}:
 *   get:
 *     summary: Get transfer status and ledger entries
 *     tags: [Transfers]
 *     parameters:
 *       - { name: id, in: path, required: true, schema: { type: string } }
 */
transfersRouter.get('/:id', transferController.getTransfer);

/**
 * @openapi
 * /transfers/{id}/fraud-signal:
 *   get:
 *     summary: Get fraud signal for a transfer (admin only)
 *     tags: [Transfers]
 *     parameters:
 *       - { name: id, in: path, required: true, schema: { type: string } }
 */
transfersRouter.get('/:id/fraud-signal', requireAdmin, transferController.fraudSignalGetOne);

/**
 * @openapi
 * /transfers/{id}/receipt:
 *   get:
 *     summary: Get MongoDB receipt for a completed transfer
 *     tags: [Transfers]
 *     parameters:
 *       - { name: id, in: path, required: true, schema: { type: string } }
 *     responses:
 *       200:
 *         description: TransactionReceipt document
 *       404:
 *         description: Receipt not found (transfer may not be completed yet)
 */
transfersRouter.get('/:id/receipt', transferController.getTransactionReceipt);