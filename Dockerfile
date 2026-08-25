# Multi-stage Dockerfile for espress0's repo
# Optimized for low-resource Azure VM

# Stage 1: Build frontend
FROM node:20-alpine AS frontend-builder
WORKDIR /app/frontend
COPY frontend/package.json frontend/package-lock.json* ./
RUN npm ci || npm install
COPY frontend/ ./
RUN npm run build

# Stage 2: Backend + frontend runner
FROM node:20-alpine AS runner
WORKDIR /app

# Install sqlite deps + tgpt dependencies + go for tgpt
RUN apk add --no-cache python3 make g++ sqlite wget bash curl go git

# Install tgpt - https://github.com/aandrew-me/tgpt
# Method 1: go install (more reliable in alpine)
RUN go install github.com/aandrew-me/tgpt@latest && \
    cp /root/go/bin/tgpt /usr/local/bin/tgpt || \
    wget -qO- https://raw.githubusercontent.com/aandrew-me/tgpt/main/install | sh -s /usr/local/bin || \
    echo "tgpt install failed, will use fallback mode"

# Verify tgpt
RUN /usr/local/bin/tgpt --version || tgpt --version || echo "tgpt not available, using fallback"

# Copy backend
COPY backend/package.json backend/package-lock.json* ./backend/
WORKDIR /app/backend
RUN npm ci --only=production || npm install --only=production

# Copy backend source
COPY backend/src ./src

# Copy frontend build
COPY --from=frontend-builder /app/frontend/dist ../frontend/dist

# Create data directories
RUN mkdir -p /app/data /app/backups /app/uploads /app/data/previews

# Copy env example and scripts
COPY .env.example ../.env.example
COPY scripts/ ../scripts/

WORKDIR /app/backend

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://localhost:3000/api/health').then(r=>{if(!r.ok)throw new Error('unhealthy')}).catch(()=>process.exit(1))"

CMD ["sh", "-c", "node src/db/migrate.js && node src/db/seed.js && node src/index.js"]
