# Multi-stage Dockerfile for espress0's repo
# Optimized for low-resource Azure VM

# Stage 1: Build frontend
#
# Pinned to the Active LTS line. The bump to node:26-alpine (#17) is what broke
# docker-build: better-sqlite3 12.2.0 declares engines "20.x || 22.x || 23.x ||
# 24.x", so the runner stage below could not install the database driver at all
# - no prebuilt binary for that ABI and no source build. better-sqlite3 13
# (below) lifts that specific block, but the pin stays on the LTS major
# deliberately: the appliance this image runs on is a 1-2 GB VM nobody watches,
# which is not where a Current release belongs. Move it when 26 goes LTS.
FROM node:24-alpine AS frontend-builder
WORKDIR /app/frontend
COPY frontend/package.json frontend/package-lock.json* ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

# Stage 2: Backend + frontend runner
FROM node:24-alpine AS runner
WORKDIR /app

# The tools the entrypoint and scripts need. No python3/make/g++: better-sqlite3
# 13 ships Node-API prebuilds for musl (prebuilds/linuxmusl-{x64,arm64}.node)
# and has no install script at all, so nothing in this image compiles - which
# also means no C toolchain sitting in the published runtime.
RUN apk add --no-cache sqlite wget bash curl git

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
# --ignore-scripts, deliberately. Nothing in the production tree declares an
# install script; what npm would otherwise run is its IMPLICIT `node-gyp
# rebuild` for better-sqlite3, triggered by the binding.gyp in the tarball.
# That build is a no-op - the gyp file detects the shipped prebuild and
# compiles nothing - but node-gyp still has to configure, which means python3,
# make, g++ and a download of the Node headers, in the runtime image, on every
# build. Skipping it keeps the toolchain out of the published image; the check
# below is what proves the result actually works.
RUN npm ci --omit=dev --ignore-scripts
# Prove the native driver actually loads on this base image. `npm ci` succeeding
# says the tarball unpacked, not that there is a binary for this platform/ABI -
# and a database driver that only fails at boot is exactly the class of break
# this Dockerfile already shipped once.
RUN node -e "const D=require('better-sqlite3'); const d=new D(':memory:'); d.exec('create table t(x)'); d.close(); console.log('better-sqlite3 ok:', require('better-sqlite3/package.json').version)"

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
