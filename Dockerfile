# Multi-stage Dockerfile for espress0's repo
# Optimized for low-resource Azure VM

# Stage 1: Build frontend
FROM node:26-alpine AS frontend-builder
WORKDIR /app/frontend
COPY frontend/package.json frontend/package-lock.json* ./
RUN npm ci || npm install
COPY frontend/ ./
RUN npm run build

# Stage 2: Backend + frontend runner
FROM node:26-alpine AS runner
WORKDIR /app

# sqlite build deps (better-sqlite3) + the tools the entrypoint needs
RUN apk add --no-cache python3 make g++ sqlite wget bash curl git

# Barista's AI backend is HTTP-first: with AI_API_KEY set the app calls the
# Gemini API directly, so the image needs no CLI. tgpt - the free, keyless
# fallback - pulls in a whole Go toolchain, so it is opt-in:
#   docker build --build-arg WITH_TGPT=true .
# AI_PROVIDER=auto then picks tgpt on a container that has no key.
ARG WITH_TGPT=false
RUN if [ "$WITH_TGPT" = "true" ]; then \
      apk add --no-cache go && \
      { go install github.com/aandrew-me/tgpt@latest \
        && cp /root/go/bin/tgpt /usr/local/bin/tgpt \
        || wget -qO- https://raw.githubusercontent.com/aandrew-me/tgpt/main/install | sh -s /usr/local/bin; } && \
      /usr/local/bin/tgpt --version; \
    else \
      echo "tgpt skipped (WITH_TGPT=false) - set AI_API_KEY to use the Gemini API"; \
    fi

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
