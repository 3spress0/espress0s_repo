# Deployment Guide — espress0's repo

Target: Ubuntu Server 24.04 LTS on small Azure VM (1 vCPU, 1GB RAM)

## Why this architecture saves Azure credit

- **No large files on VM**: SQLite DB ~120KB + frontend ~300KB, not 200GB ISOs
- **No local AI model**: Uses tgpt CLI (optional) + rule-based fallback, no GPU/RAM heavy LLM
- **SQLite + FTS5**: No separate PostgreSQL/Elasticsearch container needed (can scale later)
- **Single binary**: Node.js backend serves frontend dist, no separate frontend server
- **Redirect downloads**: VM doesn't proxy ISOs, just 302 to GDrive/OneDrive
- **Resource limits**: Docker compose limits to 1 CPU, 1GB max

## Option A: Docker + Caddy (Recommended, auto HTTPS)

```bash
# VM setup
sudo apt update && sudo apt install -y docker.io docker-compose-plugin git
sudo usermod -aG docker $USER
# logout/login

git clone https://github.com/YOUR_USERNAME/espress0s-repo.git /opt/espress0s-repo
cd /opt/espress0s-repo

cp .env.example .env
# Edit .env:
# - JWT_SECRET: openssl rand -base64 32
# - ADMIN_PASSWORD: strong password
# - CORS_ORIGIN: https://yourdomain.com
# - DATABASE_PATH: ./data/repo.db

cp Caddyfile.example Caddyfile
# Edit Caddyfile: replace espress0.example.com with your domain

# Start
docker-compose --profile with-caddy up -d --build

# Logs
docker logs -f espress0-repo
docker logs -f espress0-caddy

# Backup cron
(crontab -l 2>/dev/null; echo "0 2 * * * /opt/espress0s-repo/scripts/backup.sh") | crontab -
```

Caddy auto-provisions Let's Encrypt certs.

## Option B: Systemd + Nginx (Minimal)

```bash
# Install Node 20
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs nginx sqlite3 git

sudo useradd -m -s /bin/bash espress0
sudo mkdir -p /opt/espress0s-repo
sudo chown espress0:espress0 /opt/espress0s-repo

# As espress0 user
cd /opt/espress0s-repo
git clone <repo> .
cp .env.example .env
nano .env

cd backend && npm ci --only=production && node src/db/migrate.js && node src/db/seed.js && cd ..
cd frontend && npm ci && npm run build && cd ..

# Systemd
sudo cp systemd/espress0-repo.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now espress0-repo
sudo journalctl -u espress0-repo -f

# Nginx
sudo cp nginx.conf.example /etc/nginx/sites-available/espress0
sudo nano /etc/nginx/sites-available/espress0  # set server_name
sudo ln -s /etc/nginx/sites-available/espress0 /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx

# HTTPS
sudo apt install certbot python3-certbot-nginx
sudo certbot --nginx -d espress0.example.com
```

## GitHub Actions Deploy

Add secrets in GitHub repo -> Settings -> Secrets:

- `AZURE_VM_HOST`: VM IP or domain
- `AZURE_VM_USER`: e.g., espress0
- `AZURE_VM_SSH_KEY`: private SSH key (cat ~/.ssh/id_rsa)
- `AZURE_VM_SSH_PORT`: 22

On push to main, workflow pulls code, installs deps, migrates, rebuilds frontend, restarts service.

## Storage Setup

**Google Drive:**
1. Create folder in Drive, get folder ID from URL
2. Upload ISOs, get file IDs
3. In Admin panel: provider=gdrive, path=FILE_ID, or set download_url to share link
4. Backend returns `https://drive.google.com/uc?export=download&id=FILE_ID`

**OneDrive:**
1. Upload to OneDrive, create share link (anyone with link)
2. In Admin: provider=onedrive, download_url=share link
3. Backend converts to `?download=1` for direct download

**External:**
- provider=external, download_url=https://releases.ubuntu.com/...

## tgpt AI Setup (Optional)

```bash
# Install Go, then tgpt
curl -sSL https://raw.githubusercontent.com/aandrew-me/tgpt/main/install | bash -s /usr/local/bin

# Configure provider
tgpt --provider openai --key sk-...
# or
tgpt --provider duckduckgo  # free, no key

# Test
echo "Which Ubuntu for Intel?" | tgpt

# Env in .env
TGPT_ENABLED=true
TGPT_BINARY_PATH=/usr/local/bin/tgpt
TGPT_PROVIDER=duckduckgo
```

If tgpt unavailable, AI falls back to rule-based metadata search (still works).

## Backup Strategy

- **What**: SQLite DB (120KB), not ISOs
- **How**: `scripts/backup.sh` uses sqlite3 .backup + gzip, keeps 7 days
- **Where**: ./backups/ + optional rclone to GDrive
- **Restore**: `gunzip -c backups/repo_*.db.gz > data/repo.db`

Cron: `0 2 * * * /opt/espress0s-repo/scripts/backup.sh`

## Monitoring

- Health: `GET /api/health`
- Stats: `GET /api/stats`
- Logs: `journalctl -u espress0-repo -n 100` or `docker logs espress0-repo`
- Resource: `htop`, `docker stats`

## Scaling Later

- Switch DATABASE_PATH to PostgreSQL: set DATABASE_URL, update db/index.js to use pg
- Add Elasticsearch/Meilisearch: replace FTS5 in searchService
- Add more storage providers: implement new class extending StorageProvider, register in storage/index.js

## Security Checklist

- [ ] Change JWT_SECRET (32+ chars)
- [ ] Change ADMIN_PASSWORD
- [ ] Set CORS_ORIGIN to your domain only
- [ ] Enable UFW: `sudo ufw allow 22,80,443/tcp`
- [ ] HTTPS via Caddy or certbot
- [ ] No .env committed
- [ ] Regular backups
- [ ] Check license_status for each file
