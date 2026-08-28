/**
 * Server Entry Point
 */

import 'dotenv/config';
import http from 'http';
import { Server as SocketServer } from 'socket.io';
import app from './app.js';
import { env } from './config/env.js';
import { connectDatabase, disconnectDatabase } from './config/database.js';
import { registerIO } from './socket.js';
import { socketAuth } from './middleware/socketAuth.js';
import { setupSelfOrderNamespace } from './modules/self-order/self-order.socket.js';

// NOTE: A 60-second background auto-expiry timer used to live here. It was
// removed — it queried the DB every single minute, forever, which kept Neon's
// compute permanently awake and defeated scale-to-zero exactly the way the
// keep-alive ping this file already warns about below does. (It burned ~97% of
// a month's free compute allowance on its own.)
//
// Nothing is lost by dropping it: autoProcessExpiredBatches() is already
// called on every stock/warehouse/inventory/challan/report read path (11 call
// sites), and expiry itself is DERIVED at read time by effectiveExpiry()
// rather than stored — so quantities are correct whenever anyone actually
// looks, timer or no timer. The only change is WHEN the WasteRecord rows get
// written: at the first read after the batch expired, instead of within a
// minute of it. If a future feature genuinely needs expiry processed while
// nobody is using the app (e.g. an unattended overnight report), schedule it
// externally rather than reinstating a permanent in-process poll.

// Create HTTP server
const server = http.createServer(app);

// Initialize Socket.IO for real-time order push (KDS / POS / status boards).
const allowedOrigins = env.CORS_ORIGIN.split(',').map((origin) => origin.trim());

const io = new SocketServer(server, {
  cors: {
    origin: (origin, callback) => {
      if (!origin || allowedOrigins.includes(origin) || origin.endsWith('.vercel.app') || origin.includes('localhost')) {
        return callback(null, true);
      }
      return callback(new Error('CORS not allowed'));
    },
    methods: ['GET', 'POST'],
    credentials: true,
  },
});

// Make io available to controllers via socket.ts (emitOrderEvent), no circular import.
registerIO(io);
setupSelfOrderNamespace(io);

// Authenticate every socket handshake and join it to its outlet room, so
// outlet-scoped events (challan:*, demand:*) only reach the right branch.
io.use(socketAuth);

// Socket.IO connection handler
io.on('connection', (socket) => {
  const { userId, role, outletId } = socket.data as {
    userId: string;
    role: string;
    outletId: string | null;
  };
  console.log(`🔌 Client connected: ${socket.id} (user=${userId} role=${role} outlet=${outletId ?? '-'})`);

  socket.on('disconnect', () => {
    console.log(`🔌 Client disconnected: ${socket.id}`);
  });
});

// Export io for use in other modules
export { io };

// Graceful shutdown handler
async function gracefulShutdown(signal: string): Promise<void> {
  console.log(`\n${signal} received. Starting graceful shutdown...`);

  // Close server first (stop accepting new connections)
  server.close(() => {
    console.log('🛑 HTTP server closed');
  });

  // Disconnect from database
  await disconnectDatabase();

  process.exit(0);
}

// Handle shutdown signals
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// Handle uncaught exceptions
process.on('uncaughtException', (error: Error) => {
  console.error('💥 Uncaught Exception:', error);
  process.exit(1);
});

// Handle unhandled promise rejections
process.on('unhandledRejection', (reason: unknown, promise: Promise<unknown>) => {
  console.error('💥 Unhandled Rejection at:', promise, 'reason:', reason);
  process.exit(1);
});

// Start server
async function startServer(): Promise<void> {
  try {
    // Connect to database
    await connectDatabase();

    // NOTE: No keep-alive ping — we WANT Neon to scale-to-zero when idle to save
    // compute-hours. Cold-start wake (~3-10s) on the first request after idle is
    // handled transparently by connectDatabase()'s retry logic.

    // Start listening
    server.listen(env.PORT, () => {
      console.log(`
🔥 Ovenisto Backend Server
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📡 Server:     http://localhost:${env.PORT}
🏥 Health:     http://localhost:${env.PORT}/health
📚 API:        http://localhost:${env.PORT}/api
🌍 Environment: ${env.NODE_ENV}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
      `);
    });
  } catch (error) {
    console.error('❌ Failed to start server:', error);
    process.exit(1);
  }
}

startServer();
