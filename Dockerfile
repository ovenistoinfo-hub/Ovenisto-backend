FROM node:20-slim

# Install OpenSSL — required by Prisma's schema engine
RUN apt-get update -y && apt-get install -y openssl && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy dependency manifests and prisma schema first (better layer caching)
COPY package*.json ./
COPY prisma ./prisma/
COPY tsconfig.json ./

# Install ALL deps (including devDependencies needed for tsc)
RUN npm ci

# Copy source and compile TypeScript → dist/
COPY src ./src/
RUN npm run build

# Expose API port
EXPOSE 3001

# Push schema changes then start server
CMD ["sh", "-c", "npx prisma db push --skip-generate && node dist/index.js"]
