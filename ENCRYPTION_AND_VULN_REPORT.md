# Encryption at Rest & Vulnerability Scan Report
**espress0's repo** — Generated: 2026-08-23

## 1. Password Storage — Encrypted Way

### Before (insecure)
- Plain bcrypt: `bcrypt(password, 12)` → `$2b$12$...`
- No pepper, no versioning
- Vulnerable to: DB leak → offline brute force with rainbow tables

### Now (secure) — Pepper + bcryptjs
**Implementation:** `backend/src/services/encryptionService.js`

```javascript
// Step 1: Pepper with HMAC-SHA256 (secret key from env)
peppered = HMAC-SHA256(PASSWORD_PEPPER, password) // 64 hex chars

// Step 2: bcryptjs cost 12 (pure JS, no native tar vuln)
hash = bcryptjs.hash(peppered, 12)

// Stored with version prefix
stored = "pepper_v1:$2b$12$..."
```

**Why pepper matters:**
- Pepper is a secret key (32 bytes hex) stored in env, NOT in DB
- If attacker steals DB (SQL dump), they still need pepper to crack
- HMAC adds 256-bit secret, defeats rainbow tables even if bcrypt cracked
- Version prefix `pepper_v1:` allows future upgrades (e.g., to Argon2)

**Verification:**
```bash
$ sqlite3 data/repo.db "SELECT substr(password_hash,1,50) FROM users;"
pepper_v1:$2b$12$iktVHzFvfiku/fBs3MvgRuvT0o8Pre0N6AAovtCuHDz...

$ npm test
✓ should hash with pepper + bcrypt
✓ should have deterministic HMAC for email
```

**Env generation:**
```bash
openssl rand -hex 32    # PASSWORD_PEPPER (64 hex chars)
openssl rand -base64 32 # JWT_SECRET, ENCRYPTION_KEY
chmod 600 .env
```

---

## 2. Data Encryption — AES-256-GCM at Rest

### What is encrypted?

| Table | Field | Encryption | Searchable? | Why? |
|-------|-------|------------|-------------|------|
| users | email | AES-256-GCM random IV | No, but HMAC hash for lookup | PII, privacy |
| users | email_hash | HMAC-SHA256 deterministic | Yes | Allows login by email without decrypting all |
| users | password_hash | pepper + bcryptjs | No | Credential protection |
| items | storage_path | AES-256-GCM | No | Sensitive file IDs, paths |
| items | download_url | AES-256-GCM | No | Direct download links, may contain tokens |
| items | external_url | AES-256-GCM | No | Original source URLs |
| items | license_notes | AES-256-GCM | No | May contain internal notes |

**Not encrypted (needed for search):**
- name, slug, description, file_name, file_type, platform, architecture, tags
- These are indexed in FTS5 for fast typo-tolerant search

### How AES-256-GCM works

```javascript
// Encryption
iv = randomBytes(12) // 96-bit nonce
cipher = AES-256-GCM(key, iv)
ciphertext = cipher.update(plaintext) + final()
authTag = cipher.getAuthTag() // 16 bytes integrity

// Stored format (all base64)
enc_v1:base64(iv):base64(authTag):base64(ciphertext)

// Example:
Plain: 1Ubuntu2404ExampleFileId
Encrypted: enc_v1:FtbW9Y7lheWtUVrL:N0EPK3TbGatKJKA5qcOnPw==:gBV0Y84AFyp...
```

**Security properties:**
- Random IV per encryption → same plaintext encrypts to different ciphertext (prevents pattern analysis)
- Auth tag → tamper detection, prevents padding oracle
- Key: 32 bytes from ENCRYPTION_KEY env (base64 or hex, hashed via SHA256 if needed)
- Decrypt only in memory, never logged

### Deterministic HMAC for Email Lookup

Problem: Need to find user by email for login, but email encrypted with random IV → can't search.

Solution: Store **two** values:
- `email` = AES-256-GCM(email) with random IV (for display, secure)
- `email_hash` = HMAC-SHA256(key, lower(email)) deterministic (for lookup)

Login flow:
1. User enters `user@example.com`
2. Backend: `hash = HMAC-SHA256(key, lower(input))`
3. Query: `SELECT * FROM users WHERE email_hash = ?` (fast indexed lookup)
4. Decrypt `email` field to verify and return
5. Verify password with pepper+bcrypt

No need to decrypt all users to find one.

### Database Verification (Live)

```
USERS (encrypted at rest):
- id=1 username=admin
  email (encrypted): enc_v1:0N+Izp3XMKgFM0pA:DS9gAb1kt6BqgUNlIOwqoA==:XQlagidpX8O
  email_hash (HMAC): db87533c1ce57dbd14b149b08c1a44328a08eef36891468114c747b2f9402059
  password_hash: pepper_v1:$2b$12$iktVHzFvfiku/fBs3MvgRuvT0o8Pre0N6AAovtCuHDz...
  decrypted email: admin@espress0.local

ITEMS (encrypted at rest):
- id=1 name=Ubuntu 24.04 LTS
  storage_path (encrypted): enc_v1:FtbW9Y7lheWtUVrL:N0EPK3TbGatKJKA5qcOnPw==:gBV0Y84AFyp
  decrypted storage_path: 1Ubuntu2404ExampleFileId
```

**Even if attacker gets `repo.db` file, without `ENCRYPTION_KEY` and `PASSWORD_PEPPER` from `.env`, they cannot decrypt emails or storage paths, and passwords need pepper + bcrypt cracking.**

### Backup Encryption

`scripts/backup.sh` now supports:
- `BACKUP_ENCRYPT=true` + `ENCRYPTION_KEY` set → creates `repo_*.db.enc.gz` (AES-256-GCM encrypted file: iv + authTag + ciphertext)
- JSON exports contain encrypted values (no plaintext leak)
- `.env` redacted (no secrets in backup logs)
- Retention: 7 days, old backups deleted

---

## 3. Vulnerability Scan — Results

### A. Dependency Audit (npm audit)

**Backend:**
```
Before: 6 vulnerabilities (5 high, 1 critical) - tar via bcrypt, fastify 4 DoS
After:  0 vulnerabilities
Fix: 
  - bcrypt (native, tar vuln GHSA-34x7-hfp2-rc4v etc) → bcryptjs (pure JS)
  - fastify 4.28 → fastify 5.12.1 (fixes GHSA-mrq3-vjjr-p77c, GHSA-jx2c-rxcm-jvmq, GHSA-444r-cwp2-x5xf, GHSA-c96f-x56v-gq3h)
  - @fastify/* updated to latest for fastify 5
```

**Frontend:**
```
Before: 4 vulnerabilities (3 moderate, 1 high) - esbuild RCE GHSA-67mh-4wv8-2f99, react-router open redirect GHSA-wrjc-x8rr-h8h6
After:  0 vulnerabilities
Fix:
  - vite 5.4.21 → vite latest (6.x)
  - react-router-dom 6.23 → 7.x (fixes open redirect CVE-2025-68470 bypass)
```

**Command:**
```bash
cd backend && npm audit
cd frontend && npm audit
# both: found 0 vulnerabilities
```

### B. Secret Scanning

- `.env` is in `.gitignore`, not tracked by git ✓
- No hardcoded secrets in source (excluding `.env.example` and test dummy hashes) ✓
- `.env` permissions 600 (owner only) ✓
- Secrets from env, never exposed to browser ✓

### C. Backend Security Unit Tests (19 tests, all PASS)

```
# tests 19
# pass 19
# fail 0

- Password Hashing
  ✓ bcrypt cost 12
  ✓ pepper + bcrypt
  ✓ AES-256-GCM encrypt/decrypt
  ✓ deterministic HMAC for email
- SQL Injection Protection
  ✓ parameterized queries
  ✓ login bypass blocked
- Input Validation
  ✓ item creation Zod
  ✓ invalid storage provider rejected
  ✓ tags sanitization
- Storage Path Traversal
  ✓ prevents ../../../etc/passwd in LocalProvider
  ✓ allows http URLs
- JWT Security
  ✓ valid JWT with expiry
  ✓ rejects invalid JWT
- Search Security
  ✓ XSS payload without execution
  ✓ SQLi payload in search
- AI Security
  ✓ sanitizes hallucinated URLs
  ✓ no hallucination for random string
```

Run: `cd backend && npm test`

### D. Live HTTP Tests (12 tests, all PASS)

`scripts/test-vuln.sh` — safe dummy payloads:

```
✓ Health endpoint accessible
✓ SQLi login bypass blocked (401) — payload: ' OR '1'='1
✓ Search SQLi blocked (0 items, not full dump) — payload: ' OR 1=1 --
✓ XSS protected (React auto-escapes) — payload: <script>alert('XSS')</script>
✓ Admin protected (401 without token)
✓ Invalid JWT rejected (401)
✓ Path traversal blocked (400 for encoded ../) — payload: ..%2F..%2Fetc%2Fpasswd
✓ Weak password rejected (400) — payload: 123
✓ Valid registration works (201) — returns pepper+bcrypt info
✓ Rate limiting active (429 after 10 brute force)
✓ CORS allowlist configured
✓ Helmet headers present (nosniff, SAMEORIGIN, HSTS max-age=31536000)
```

**Path traversal detail:**
- Plain `/api/download/../../../etc/passwd` normalizes to `/etc/passwd` → serves `index.html` (SPA fallback), NOT file system — safe, not vulnerable
- Encoded `/api/download/..%2F..%2Fetc%2Fpasswd` → blocked by onRequest hook → 400 `path traversal detected` — protected

### E. Comprehensive Scan

`scripts/vuln-scan.sh` runs all above plus:
- Encryption at rest verification (counts encrypted emails, storage_path, peppered passwords)
- Key configuration check (ENCRYPTION_KEY, PEPPER, JWT set, not default)
- File permissions (.env 600)
- Backup encryption status

Run `scripts/vuln-scan.sh` to generate a fresh report for your own deployment.
Earlier scan reports were deliberately excluded from this archive: they embed
tokens captured during test registrations and internal machine paths.

### F. Interactive Lab

Visit `/security` for:
- 10 automated vuln tests with live payloads
- Custom payload tester against `/api/search`
- Protections list, headers, auth flows
- Quick payload buttons

Visit `/encryption` for:
- How pepper+bcrypt and AES-256-GCM work with diagrams
- Live encryption status (requires admin login)
- Test encryption demo
- Key management guide

---

## 4. Recommendations for Production

- [x] Generate strong keys: `openssl rand -base64 32` for ENCRYPTION_KEY, JWT_SECRET; `openssl rand -hex 32` for PEPPER
- [x] `chmod 600 .env`
- [x] `ENCRYPTION_KEY`, `PASSWORD_PEPPER`, `JWT_SECRET` set (not default)
- [x] `ALLOW_REGISTRATION=true` (viewer role) or false for invite-only
- [x] HTTPS via Caddy/Nginx + HSTS
- [x] Backups encrypted (`BACKUP_ENCRYPT=true`)
- [x] `npm audit` 0 vulns (update deps regularly: `npm audit fix`)
- [x] Rate limiting enabled
- [ ] Rotate keys yearly: decrypt with old, encrypt with new, update `encryption_version`
- [ ] Monitor logs for blocked traversal attempts (`Blocked path traversal attempt`)
- [ ] Use WAF (Cloudflare, ModSecurity) in front of Azure VM for extra protection

---

## 5. Commands to Reproduce

```bash
# Check encrypted DB
cd backend
node -e "import {getDb} from './src/db/index.js'; console.log(getDb().prepare('SELECT substr(email,1,40), substr(password_hash,1,40) FROM users').all())"

# Run security tests
npm test

# HTTP vuln tests
./scripts/test-vuln.sh

# Full scan
./scripts/vuln-scan.sh

# Dependency audit
npm audit
cd ../frontend && npm audit

# Encryption status (needs admin token)
TOKEN=$(curl -s -X POST http://localhost:3000/api/auth/login -H "Content-Type: application/json" -d '{"username":"admin","password":"ChangeMe123!"}' | python3 -c "import sys,json;print(json.load(sys.stdin)['token'])")
curl -s http://localhost:3000/api/auth/encryption-status -H "Authorization: Bearer $TOKEN" | python3 -m json.tool
```

**Result: Passwords and sensitive data encrypted at rest with AES-256-GCM + pepper+bcrypt, 0 npm vulnerabilities, all security tests PASS.**
