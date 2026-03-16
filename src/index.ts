/**
 * Server Entry Point
 */

import 'dotenv/config';
import http from 'http';
import { Server as SocketServer } from 'socket.io';
import app from './app.js';
import { env } from './config/env.js';
import { connectDatabase, disconnectDatabase } from './config/database.js';

// Create HTTP server
const server = http.createServer(app);

// Initialize Socket.IO (for real-time features in later phases)
const io = new SocketServer(server, {
  cors: {
    origin: env.CORS_ORIGIN.split(',').map((origin) => origin.trim()),
    methods: ['GET', 'POST'],
    credentials: true,
  },
});

// Socket.IO connection handler (placeholder for Phase 5+)
io.on('connection', (socket) => {
  console.log(`🔌 Client connected: ${socket.id}`);

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
