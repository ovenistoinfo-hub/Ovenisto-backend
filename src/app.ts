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
import { prisma } from './config/database.js';
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
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Outlet-Id'],
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

// Health check endpoint (static — does NOT touch the DB, safe for uptime monitors)
app.get('/health', (_req: Request, res: Response) => {
  res.json(
    ApiResponse.success({
      status: 'healthy',
      timestamp: new Date().toISOString(),
      environment: env.NODE_ENV,
    })
  );
});

// DB warm-up endpoint — runs a trivial query to wake Neon from scale-to-zero.
// The frontend fires this (fire-and-forget) when the Login page mounts, so the
// database wakes WHILE the user types credentials, hiding the ~3-10s cold-start.
// NOTE: deliberately NOT on a timer/cron — that would re-create the 24/7 compute burn
// we removed. It only runs on an actual user arriving at the login screen.
app.get('/health/db', async (_req: Request, res: Response) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    res.json(ApiResponse.success({ status: 'db-ready' }));
  } catch {
    // Cold-start may still be in progress; report not-ready without erroring loudly.
    res.status(503).json(ApiResponse.success({ status: 'db-waking' }));
  }
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
