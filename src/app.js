import 'express-async-errors';
import express from 'express';
import pinoHttp from 'pino-http';
import {logger} from './utils/logger.js';
import {correlationId} from './middleware/correlationId.js';
import {errorHandler} from './middleware/errorHandler.js';
import { ApiResponse } from './utils/ApiResponse.js';
import {swaggerRouter} from './swagger.js';


export const app = express();

// 1. Request logging — first so every request is captured, including those that fail body parsing
app.use(pinoHttp({ logger }));

// 2. Body parsing
app.use(express.json());

// 3. Correlation ID — after pinoHttp so req.log exists for the child logger
app.use(correlationId);

// 4. Swagger UI — development only
if (process.env.NODE_ENV !== 'production') {
    app.use('/swagger', swaggerRouter);
}

// Routes are mounted in later phases:
import { authRouter } from './routes/auth.js';
app.use('/api/v1/auth', authRouter)
// app.use('/api/v1/accounts', accountsRouter);
// app.use('/api/v1/transfers', transfersRouter);

// 5. 404 catch-all — after all valid routes, before error handler
app.use((req, res) => {
    res.status(404).json(ApiResponse.error('Route not found.', 'NOT_FOUND', 404));
});

// 6. Global error handler — must be last, four-argument signature required
app.use(errorHandler);