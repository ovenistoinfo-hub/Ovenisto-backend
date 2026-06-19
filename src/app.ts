/**
 * Express Application Configuration
 */

import express, { type Application, type Request, type Response } from 'express';
import cors from 'cors';
import compression from 'compression';
import morgan from 'morgan';
import { env } from './config/env.js';
import { errorHandler } from './middleware/errorHandler.js';
import { ApiResponse } from './utils/ApiResponse.js';
import routes from './routes/index.js';

const app: Application = express();

// ============================================
// MIDDLEWARE
// ============================================

// CORS - Allow frontend to access API
app.use(
  cors({
    origin: env.CORS_ORIGIN.split(',').map((origin) => origin.trim()),
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  })
);

// gzip-compress all responses — shrinks large JSON list payloads (POS menu, orders)
// by ~70-85%, which matters most on slow restaurant tablet WiFi/4G.
app.use(compression());

// Request logging
if (env.NODE_ENV !== 'test') {
  app.use(morgan(env.NODE_ENV === 'development' ? 'dev' : 'combined'));
}

// Body parsing
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// ============================================
// ROUTES
// ============================================

// Health check endpoint
app.get('/health', (_req: Request, res: Response) => {
  res.json(
    ApiResponse.success({
      status: 'healthy',
      timestamp: new Date().toISOString(),
      environment: env.NODE_ENV,
    })
  );
});

// API routes
app.use('/api', routes);

// 404 handler
app.use((_req: Request, res: Response) => {
  res.status(404).json(ApiResponse.error('Endpoint not found'));
});

// Global error handler (must be last)
app.use(errorHandler);

export default app;
