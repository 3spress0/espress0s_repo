#!/bin/bash
set -e

echo "=== espress0's repo — Codespace post-create ==="

# Ensure Node 20 (better-sqlite3 v12 supports Node 24, but 20 is more stable)
if command -v nvm &> /dev/null; then
  echo "Checking Node version..."
  node -v
  if node -v | grep -q "v24"; then
    echo "Node 24 detected — installing Node 20 for better-sqlite3 compatibility"
    nvm install 20
    nvm use 20
    nvm alias default 20
  fi
fi

echo "Node version: $(node -v)"
echo "npm version: $(npm -v)"

# Install tgpt - https://github.com/aandrew-me/tgpt
echo "Installing tgpt (Barista AI backend)..."
if ! command -v tgpt &> /dev/null; then
  if command -v go &> /dev/null; then
    echo "Installing via go..."
    go install github.com/aandrew-me/tgpt@latest
    sudo cp ~/go/bin/tgpt /usr/local/bin/tgpt 2>/dev/null || cp ~/go/bin/tgpt /usr/local/bin/tgpt 2>/dev/null || true
  else
    echo "Installing via install script..."
    curl -sSL https://raw.githubusercontent.com/aandrew-me/tgpt/main/install | bash -s /usr/local/bin 2>&1 || echo "tgpt install via script failed"
  fi
else
  echo "tgpt already installed"
fi

tgpt --version 2>&1 || /usr/local/bin/tgpt --version 2>&1 || echo "tgpt not available, will use fallback mode (rule-based)"

# Generate .env if not exists
if [ ! -f "../.env" ] && [ ! -f ".env" ]; then
  echo "Creating .env from template..."
  cp ../.env.example ../.env 2>/dev/null || cp .env.example .env 2>/dev/null || true
  if [ -f "../.env" ]; then ENV_FILE="../.env"; else ENV_FILE=".env"; fi
  
  if grep -q "change-this" "$ENV_FILE" 2>/dev/null; then
    echo "Generating secure keys..."
    ENC_KEY=$(openssl rand -base64 32 2>/dev/null || echo "dev-enc-key-$(date +%s)")
    PEPPER=$(openssl rand -hex 32 2>/dev/null || echo "dev-pepper-$(date +%s)")
    JWT=$(openssl rand -base64 32 2>/dev/null || echo "dev-jwt-$(date +%s)-min-32-chars-long")
    
    sed -i "s|JWT_SECRET=.*|JWT_SECRET=$JWT|" "$ENV_FILE" 2>/dev/null || true
    sed -i "s|ENCRYPTION_KEY=.*|ENCRYPTION_KEY=$ENC_KEY|" "$ENV_FILE" 2>/dev/null || true
    sed -i "s|PASSWORD_PEPPER=.*|PASSWORD_PEPPER=$PEPPER|" "$ENV_FILE" 2>/dev/null || true
    sed -i "s|CAPTCHA_TYPE=.*|CAPTCHA_TYPE=math|" "$ENV_FILE" 2>/dev/null || true
    chmod 600 "$ENV_FILE" 2>/dev/null || true
    echo ".env generated with secure keys"
  fi
fi

# Backend setup
echo "Setting up backend..."
cd backend 2>/dev/null || cd ../backend 2>/dev/null || true
if [ -f "package.json" ]; then
  echo "Installing backend deps..."
  npm install
  echo "Running migrations..."
  node src/db/migrate.js || echo "Migrate failed"
  echo "Seeding (encrypted)..."
  node src/db/seed.js || echo "Seed failed (may already exist)"
  echo "Running security tests..."
  npm test 2>&1 | tail -n 10 || echo "Tests failed"
  cd ..
fi

# Frontend setup
echo "Setting up frontend..."
cd frontend 2>/dev/null || cd ../frontend 2>/dev/null || true
if [ -f "package.json" ]; then
  echo "Installing frontend deps..."
  npm install --legacy-peer-deps
  echo "Building frontend..."
  npm run build || echo "Build failed"
  cd ..
fi

echo ""
echo "=== Setup complete ==="
echo "Theme colors: Primary #8b5cf6 (purple) -> #3b82f6 (blue) gradient"
echo "AI Name: Barista — purpose: easily find files"
echo "tgpt: $(tgpt --version 2>&1 || echo 'fallback mode')"
echo "To run prod (backend serves frontend on 3000):"
echo "  cd backend && NODE_ENV=production PORT=3000 HOST=0.0.0.0 node src/index.js"
echo ""
echo "To run dev (2 terminals):"
echo "  Terminal 1: cd backend && npm run dev"
echo "  Terminal 2: cd frontend && npm run dev"
echo ""
echo "Login: admin / ChangeMe123! + CAPTCHA"
echo "Ports 3000 and 5173 will be auto-forwarded"
