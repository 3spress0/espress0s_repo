#!/bin/bash
set -e

echo "Initializing espress0's repo database..."

# Ensure data directory
mkdir -p ./data ./backups

# Check Node
if ! command -v node &> /dev/null; then
    echo "Node.js not found. Please install Node 18+"
    exit 1
fi

# Install backend deps if needed
if [ ! -d "backend/node_modules" ]; then
    echo "Installing backend dependencies..."
    cd backend && npm install && cd ..
fi

# Run migrations
echo "Running migrations..."
cd backend && node src/db/migrate.js && cd ..

# Seed
echo "Seeding database..."
cd backend && node src/db/seed.js && cd ..

echo "Database initialized successfully!"
echo "Data location: ./data/repo.db"
ls -lh ./data/
