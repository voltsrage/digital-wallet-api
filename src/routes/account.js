import { Router } from "express";
import * as accountController from '../controllers/accountController.js';
import {authenticate} from '../middleware/authenticate.js';

export const accountsRouter = Router();

accountsRouter.use(authenticate);

/**
 * @openapi
 * components:
 *   schemas:
 *     Account:
 *       type: object
 *       properties:
 *         id:            { type: string, format: uuid }
 *         userId:        { type: string, format: uuid }
 *         accountNumber: { type: string, example: ACC-00123456 }
 *         currency:      { type: string, example: USD }
 *         balance:       { type: string, example: "0.00", description: Decimal string — never a JS Number }
 *         status:        { type: string, enum: [active, frozen, closed] }
 *         dailyLimit:    { type: string, example: "1000.00" }
 *         createdAt:     { type: string, format: date-time }
 *         updatedAt:     { type: string, format: date-time }
 */

/**
 * @openapi
 * /accounts:
 *   post:
 *     summary: Create a new wallet account
 *     tags: [Accounts]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               currency: { type: string, example: USD, default: USD }
 *     responses:
 *       201:
 *         description: Account created
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:    { type: boolean, example: true }
 *                 statusCode: { type: integer, example: 201 }
 *                 data:       { $ref: '#/components/schemas/Account' }
 *                 error:      { type: object, nullable: true, example: null }
 *       401:
 *         description: Missing or invalid access token
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/ErrorResponse' }
 */
accountsRouter.post('/', accountController.createAccount);

/**
 * @openapi
 * /accounts:
 *   get:
 *     summary: List all accounts for the authenticated user
 *     tags: [Accounts]
 *     responses:
 *       200:
 *         description: Account list
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:    { type: boolean, example: true }
 *                 statusCode: { type: integer, example: 200 }
 *                 data:
 *                   type: array
 *                   items: { $ref: '#/components/schemas/Account' }
 *                 error: { type: object, nullable: true, example: null }
 *       401:
 *         description: Missing or invalid access token
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/ErrorResponse' }
 */
accountsRouter.get('/',accountController.listAccounts);

/**
 * @openapi
 * /accounts/{id}:
 *   get:
 *     summary: Get a single account by ID
 *     tags: [Accounts]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: Account found
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:    { type: boolean, example: true }
 *                 statusCode: { type: integer, example: 200 }
 *                 data:       { $ref: '#/components/schemas/Account' }
 *                 error:      { type: object, nullable: true, example: null }
 *       401:
 *         description: Missing or invalid access token
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/ErrorResponse' }
 *       403:
 *         description: Account belongs to a different user
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/ErrorResponse' }
 *       404:
 *         description: Account not found
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/ErrorResponse' }
 */
accountsRouter.get('/:id', accountController.getAccount);

/**
 * @openapi
 * /accounts/{id}/freeze:
 *   post:
 *     summary: Freeze an active account
 *     description: Valid transition — active → frozen. Returns 400 if the account is already frozen or closed.
 *     tags: [Accounts]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: Account frozen
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:    { type: boolean, example: true }
 *                 statusCode: { type: integer, example: 200 }
 *                 data:       { $ref: '#/components/schemas/Account' }
 *                 error:      { type: object, nullable: true, example: null }
 *       400:
 *         description: Invalid status transition
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/ErrorResponse' }
 *       401:
 *         description: Missing or invalid access token
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/ErrorResponse' }
 *       403:
 *         description: Account belongs to a different user
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/ErrorResponse' }
 *       404:
 *         description: Account not found
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/ErrorResponse' }
 */
accountsRouter.post('/:id/freeze', accountController.freezeAccount);

/**
 * @openapi
 * /accounts/{id}/unfreeze:
 *   post:
 *     summary: Unfreeze a frozen account
 *     description: Valid transition — frozen → active. Returns 400 if the account is active or closed.
 *     tags: [Accounts]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: Account unfrozen
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:    { type: boolean, example: true }
 *                 statusCode: { type: integer, example: 200 }
 *                 data:       { $ref: '#/components/schemas/Account' }
 *                 error:      { type: object, nullable: true, example: null }
 *       400:
 *         description: Invalid status transition
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/ErrorResponse' }
 *       401:
 *         description: Missing or invalid access token
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/ErrorResponse' }
 *       403:
 *         description: Account belongs to a different user
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/ErrorResponse' }
 *       404:
 *         description: Account not found
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/ErrorResponse' }
 */
accountsRouter.post('/:id/unfreeze', accountController.unfreezeAccount);

/**
 * @openapi
 * /accounts/{id}/close:
 *   post:
 *     summary: Permanently close an account
 *     description: |
 *       Terminal transition — active or frozen → closed. The account balance must be exactly
 *       zero; a non-zero balance returns 400 with code `ACCOUNT_HAS_BALANCE`. Closed accounts
 *       cannot be reopened.
 *     tags: [Accounts]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: Account closed
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:    { type: boolean, example: true }
 *                 statusCode: { type: integer, example: 200 }
 *                 data:       { $ref: '#/components/schemas/Account' }
 *                 error:      { type: object, nullable: true, example: null }
 *       400:
 *         description: Invalid transition or non-zero balance (`ACCOUNT_HAS_BALANCE`)
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/ErrorResponse' }
 *       401:
 *         description: Missing or invalid access token
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/ErrorResponse' }
 *       403:
 *         description: Account belongs to a different user
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/ErrorResponse' }
 *       404:
 *         description: Account not found
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/ErrorResponse' }
 */
accountsRouter.post('/:id/close', accountController.closeAccount);
