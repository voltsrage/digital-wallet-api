import { Router } from "express";
import * as authController from '../controllers/authController.js';

export const authRouter = Router();

/**
 * @openapi
 * components:
 *   schemas:
 *     PublicUser:
 *       type: object
 *       properties:
 *         id:          { type: string, format: uuid }
 *         email:       { type: string, format: email }
 *         displayName: { type: string, nullable: true }
 *         createdAt:   { type: string, format: date-time }
 *     AuthTokens:
 *       type: object
 *       properties:
 *         accessToken:  { type: string, description: Short-lived JWT }
 *         refreshToken: { type: string, description: Long-lived opaque token }
 *     ErrorBody:
 *       type: object
 *       properties:
 *         message: { type: string }
 *         code:    { type: string, nullable: true }
 *     ErrorResponse:
 *       type: object
 *       properties:
 *         success:    { type: boolean, example: false }
 *         statusCode: { type: integer }
 *         data:       { type: object, nullable: true, example: null }
 *         error:      { $ref: '#/components/schemas/ErrorBody' }
 */

/**
 * @openapi
 * /auth/register:
 *   post:
 *     summary: Register a new user
 *     tags: [Auth]
 *     security: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [email, password]
 *             properties:
 *               email:       { type: string, format: email, example: user@example.com }
 *               password:    { type: string, minLength: 8, example: hunter2secret }
 *               displayName: { type: string, example: Alice }
 *     responses:
 *       201:
 *         description: User registered successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:    { type: boolean, example: true }
 *                 statusCode: { type: integer, example: 201 }
 *                 data:
 *                   type: object
 *                   properties:
 *                     user:         { $ref: '#/components/schemas/PublicUser' }
 *                     accessToken:  { type: string }
 *                     refreshToken: { type: string }
 *                 error: { type: object, nullable: true, example: null }
 *       400:
 *         description: Missing or invalid fields
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/ErrorResponse' }
 *       409:
 *         description: Email already registered
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/ErrorResponse' }
 */
authRouter.post('/register', authController.register);

/**
 * @openapi
 * /auth/login:
 *   post:
 *     summary: Login with email and password
 *     tags: [Auth]
 *     security: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [email, password]
 *             properties:
 *               email:    { type: string, format: email, example: user@example.com }
 *               password: { type: string, example: hunter2secret }
 *     responses:
 *       200:
 *         description: Logged in successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:    { type: boolean, example: true }
 *                 statusCode: { type: integer, example: 200 }
 *                 data:
 *                   type: object
 *                   properties:
 *                     user:         { $ref: '#/components/schemas/PublicUser' }
 *                     accessToken:  { type: string }
 *                     refreshToken: { type: string }
 *                 error: { type: object, nullable: true, example: null }
 *       400:
 *         description: Missing email or password
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/ErrorResponse' }
 *       401:
 *         description: Invalid credentials or account locked
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/ErrorResponse' }
 */
authRouter.post('/login', authController.login);

/**
 * @openapi
 * /auth/refresh:
 *   post:
 *     summary: Rotate a refresh token and receive a new access token
 *     tags: [Auth]
 *     security: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [refreshToken]
 *             properties:
 *               refreshToken: { type: string }
 *     responses:
 *       200:
 *         description: Tokens rotated successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:    { type: boolean, example: true }
 *                 statusCode: { type: integer, example: 200 }
 *                 data:       { $ref: '#/components/schemas/AuthTokens' }
 *                 error:      { type: object, nullable: true, example: null }
 *       400:
 *         description: Missing refresh token
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/ErrorResponse' }
 *       401:
 *         description: Invalid or expired refresh token
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/ErrorResponse' }
 */
authRouter.post('/refresh', authController.refresh);

/**
 * @openapi
 * /auth/logout:
 *   post:
 *     summary: Revoke a refresh token (logout)
 *     description: Idempotent — returns 200 even if the token is already invalid or expired.
 *     tags: [Auth]
 *     security: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [refreshToken]
 *             properties:
 *               refreshToken: { type: string }
 *     responses:
 *       200:
 *         description: Logged out (token revoked or already invalid)
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:    { type: boolean, example: true }
 *                 statusCode: { type: integer, example: 200 }
 *                 data:       { type: object, nullable: true, example: null }
 *                 error:      { type: object, nullable: true, example: null }
 *       400:
 *         description: Missing refresh token
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/ErrorResponse' }
 */
authRouter.post('/logout', authController.logout);
