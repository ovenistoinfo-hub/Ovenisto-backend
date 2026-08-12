FROM node:20-slim

# Install OpenSSL — required by Prisma's schema engine
RUN apt-get update -y && apt-get install -y openssl && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy dependency manifests, prisma schema, and scripts first (better layer caching)
COPY package*.json ./
COPY prisma ./prisma/
COPY tsconfig.json ./
COPY scripts ./scripts/

# Install ALL deps (including devDependencies needed for tsc)
RUN npm ci

# Copy source and compile TypeScript → dist/
COPY src ./src/
RUN npm run build

# Prune devDependencies — shrinks final image (~40% smaller)
RUN npm prune --production

# Run as non-root user for security
RUN addgroup --system appgroup && adduser --system --ingroup appgroup appuser
# Give appuser ownership of /app so Prisma can write to node_modules/.prisma at runtime
RUN chown -R appuser:appgroup /app
USER appuser

# Expose API port
EXPOSE 3001

# Use retry wrapper for db push (handles Neon cold-start), then start server
CMD ["sh", "-c", "node scripts/db-push.mjs && node dist/index.js"]
