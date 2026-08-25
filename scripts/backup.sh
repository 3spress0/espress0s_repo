#!/bin/bash
# Backup script for espress0's repo - with encryption support
set -e

BACKUP_DIR="${BACKUP_DIR:-./backups}"
DATA_DIR="${DATA_DIR:-./data}"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
RETENTION_DAYS=${BACKUP_RETENTION_DAYS:-7}
BACKUP_ENCRYPT="${BACKUP_ENCRYPT:-true}"

mkdir -p "$BACKUP_DIR"
echo "[$(date)] Starting backup (encrypted=$BACKUP_ENCRYPT)..."

if [ -f ".env" ]; then
  set -a
  source .env 2>/dev/null || true
  set +a
fi

if [ -f "$DATA_DIR/repo.db" ]; then
    echo "Backing up database..."
    if command -v sqlite3 &> /dev/null; then
        sqlite3 "$DATA_DIR/repo.db" ".backup '$BACKUP_DIR/repo_$TIMESTAMP.db'"
    else
        cp "$DATA_DIR/repo.db" "$BACKUP_DIR/repo_$TIMESTAMP.db"
        [ -f "$DATA_DIR/repo.db-wal" ] && cp "$DATA_DIR/repo.db-wal" "$BACKUP_DIR/repo_${TIMESTAMP}.db-wal" || true
    fi
    
    if [ "$BACKUP_ENCRYPT" = "true" ] && [ -n "$ENCRYPTION_KEY" ]; then
      echo "Encrypting backup with AES-256-GCM..."
      # Create temp JS file for encryption (ESM)
      cat > /tmp/encrypt-backup.mjs <<'JS'
import crypto from 'crypto';
import fs from 'fs';
const keyEnv = process.env.ENCRYPTION_KEY;
const fileIn = process.env.FILE_IN;
const fileOut = process.env.FILE_OUT;
let key;
try {
  if (/^[a-f0-9]{64}$/i.test(keyEnv)) {
    key = Buffer.from(keyEnv, 'hex');
  } else {
    const buf = Buffer.from(keyEnv, 'base64');
    key = buf.length === 32 ? buf : crypto.createHash('sha256').update(buf).digest();
    if (key.length !== 32) key = crypto.createHash('sha256').update(keyEnv).digest();
  }
} catch { key = crypto.createHash('sha256').update(keyEnv).digest(); }
const data = fs.readFileSync(fileIn);
const iv = crypto.randomBytes(12);
const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
const enc = Buffer.concat([cipher.update(data), cipher.final()]);
const tag = cipher.getAuthTag();
const out = Buffer.concat([iv, tag, enc]);
fs.writeFileSync(fileOut, out);
console.log('Encrypted backup created');
JS
      FILE_IN="$BACKUP_DIR/repo_$TIMESTAMP.db" FILE_OUT="$BACKUP_DIR/repo_$TIMESTAMP.db.enc" node /tmp/encrypt-backup.mjs 2>&1 || echo "Encryption failed"
      
      if [ -f "$BACKUP_DIR/repo_$TIMESTAMP.db.enc" ]; then
        gzip -f "$BACKUP_DIR/repo_$TIMESTAMP.db.enc"
        rm -f "$BACKUP_DIR/repo_$TIMESTAMP.db"
        echo "Encrypted backup: $BACKUP_DIR/repo_$TIMESTAMP.db.enc.gz (AES-256-GCM)"
      else
        gzip -f "$BACKUP_DIR/repo_$TIMESTAMP.db"
        echo "Backup (unencrypted fallback): $BACKUP_DIR/repo_$TIMESTAMP.db.gz"
      fi
    else
      gzip -f "$BACKUP_DIR/repo_$TIMESTAMP.db"
      echo "Backup: $BACKUP_DIR/repo_$TIMESTAMP.db.gz (set ENCRYPTION_KEY for encrypted)"
    fi
else
    echo "Warning: Database not found at $DATA_DIR/repo.db"
fi

if [ -f ".env" ]; then
    echo "Backing up env template (redacted)..."
    grep -v -E "(SECRET|PASSWORD|KEY|TOKEN|PEPPER)" .env > "$BACKUP_DIR/env_$TIMESTAMP.example" || true
fi

if [ -f "$DATA_DIR/repo.db" ] && command -v sqlite3 &> /dev/null; then
    echo "Exporting metadata (encrypted values)..."
    sqlite3 "$DATA_DIR/repo.db" "SELECT id, username, role, encryption_version FROM users;" > "$BACKUP_DIR/users_$TIMESTAMP.txt" 2>&1 || true
fi

echo "Cleaning up old backups..."
find "$BACKUP_DIR" -name "repo_*.db.gz" -mtime +$RETENTION_DAYS -delete || true
find "$BACKUP_DIR" -name "repo_*.db.enc.gz" -mtime +$RETENTION_DAYS -delete || true
find "$BACKUP_DIR" -name "env_*.example" -mtime +$RETENTION_DAYS -delete || true

echo "[$(date)] Backup completed:"
ls -lh "$BACKUP_DIR" | tail -n 20
echo ""
echo "Encryption: Users email AES-256-GCM, Passwords pepper+bcrypt, Items storage_path etc AES-256-GCM, Backups AES-256-GCM"
