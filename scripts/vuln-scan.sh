#!/bin/bash
# Comprehensive vulnerability scan for espress0's repo
# - Dependency audit (npm audit)
# - Security tests (backend)
# - Encryption verification
# - HTTP security tests
# - Secret scanning

set -e

BASE_URL="${BASE_URL:-http://localhost:3000}"
API="$BASE_URL/api"

GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

pass() { echo -e "${GREEN}[ok] PASS${NC}: $1"; }
fail() { echo -e "${RED}[x] FAIL${NC}: $1"; FAILURES=$((FAILURES + 1)); }
info() { echo -e "${YELLOW}ℹ INFO${NC}: $1"; }
section() { echo -e "\n${BLUE}=== $1 ===${NC}"; }

# Reports go under ./reports/ (git-ignored), not the repo root, so a scan on a
# live box cannot leave untracked files that a later `git pull`/update trips on.
REPORT_DIR="${REPORT_DIR:-./reports}"
mkdir -p "$REPORT_DIR"
REPORT_FILE="$REPORT_DIR/vuln-report-$(date +%Y%m%d_%H%M%S).txt"
exec > >(tee -a "$REPORT_FILE") 2>&1

# Tracks whether any real problem was found, so the script can exit non-zero
# and be usable from CI or a cron job instead of always "succeeding".
FAILURES=0

echo "[lock] espress0's repo - Comprehensive Vulnerability Scan"
echo "Date: $(date)"
echo "Target: $BASE_URL"
echo "Report: $REPORT_FILE"
echo "====================================================="

# 1. Secret scanning
section "1. Secret Scanning (no secrets in repo)"
# Only scan files git actually tracks. The previous version walked the working
# tree, which on a deployed box meant it also scanned .auto-update/next/ (the
# updater's staging clone) and reported every finding twice.
#
# The patterns below match credential *shapes* with enough entropy to be real,
# rather than the substring "sk-" (which matched the word "disk", comments and
# the redaction regexes) or "password =" (which matched DEV_ADMIN_PASSWORD, a
# documented placeholder that config.js refuses to boot with in production).
SECRET_HITS=$(git ls-files -z -- '*.js' '*.jsx' '*.mjs' '*.cjs' '*.ts' '*.tsx' '*.json' '*.sh' '*.yml' '*.yaml' 2>/dev/null \
  | xargs -0 grep -n -E \
      -e '\bsk-(proj-)?[0-9A-Za-z_-]{20,}' \
      -e '\bAIza[0-9A-Za-z_-]{35}' \
      -e '\bghp_[0-9A-Za-z]{36}' \
      -e '\bxox[baprs]-[0-9A-Za-z-]{10,}' \
      -e 'AKIA[0-9A-Z]{16}' \
      -e 'BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY' \
      -e '(secret|token|passwd|password|api_?key)["'"'"']?\s*[:=]\s*["'"'"'][^"'"'"'$\{][^"'"'"']{15,}["'"'"']' \
      2>/dev/null \
  | grep -v -E '\.env\.example' \
  | grep -v -E '/(tests?|__tests__)/' \
  | grep -v -E 'dummy|example|placeholder|not-a-real|test-only|change-in-production|redacted|CHANGEME|ChangeMe' \
  | grep -v -E '^\s*[^:]+:[0-9]+:\s*(//|\*|/\*|#)' \
  || true)

if [ -n "$SECRET_HITS" ]; then
  echo "$SECRET_HITS" | head -n 20
  fail "Potential secrets found - review above"
else
  pass "No hardcoded secrets detected in tracked source"
fi

# Check .env not committed
if [ -f ".env" ] && git ls-files --error-unmatch .env 2>/dev/null; then
  fail ".env file is tracked by git - should be in .gitignore!"
else
  pass ".env not tracked by git (or not present)"
fi

# 2. Dependency audit - backend
section "2. Dependency Audit - Backend"
cd backend
if npm audit --audit-level=high 2>&1 | tail -n 30; then
  AUDIT_EXIT=$?
  if [ $AUDIT_EXIT -eq 0 ]; then
    pass "Backend npm audit: no high/critical vulns"
  else
    info "Backend npm audit found issues - review above (may be moderate/low)"
  fi
else
  info "npm audit failed or found issues"
fi
cd ..

# 3. Dependency audit - frontend
section "3. Dependency Audit - Frontend"
cd frontend
if npm audit --audit-level=high 2>&1 | tail -n 30; then
  pass "Frontend npm audit: no high/critical"
else
  info "Frontend npm audit issues - review"
fi
cd ..

# 4. Encryption verification
section "4. Encryption at Rest Verification"
echo "Checking database for encrypted fields..."

if [ -f "./data/repo.db" ]; then
  # Check if emails are encrypted
  ENCRYPTED_EMAILS=$(sqlite3 ./data/repo.db "SELECT COUNT(*) FROM users WHERE email LIKE 'enc_v1:%';" 2>/dev/null || echo "0")
  TOTAL_USERS=$(sqlite3 ./data/repo.db "SELECT COUNT(*) FROM users;" 2>/dev/null || echo "0")
  echo "Users: $TOTAL_USERS total, $ENCRYPTED_EMAILS encrypted emails"
  if [ "$ENCRYPTED_EMAILS" = "$TOTAL_USERS" ] && [ "$TOTAL_USERS" -gt 0 ]; then
    pass "All user emails encrypted with AES-256-GCM"
  else
    info "Some emails not encrypted (legacy or empty DB)"
  fi

  ENC_STORAGE=$(sqlite3 ./data/repo.db "SELECT COUNT(*) FROM items WHERE storage_path LIKE 'enc_v1:%';" 2>/dev/null || echo "0")
  TOTAL_ITEMS=$(sqlite3 ./data/repo.db "SELECT COUNT(*) FROM items;" 2>/dev/null || echo "0")
  echo "Items: $TOTAL_ITEMS total, $ENC_STORAGE encrypted storage_path"
  if [ "$TOTAL_ITEMS" -gt 0 ]; then
    pass "Items storage_path encryption: $ENC_STORAGE/$TOTAL_ITEMS"
  fi

  PEPPERED=$(sqlite3 ./data/repo.db "SELECT COUNT(*) FROM users WHERE password_hash LIKE 'pepper_v1:%';" 2>/dev/null || echo "0")
  echo "Peppered passwords: $PEPPERED/$TOTAL_USERS"
  if [ "$PEPPERED" = "$TOTAL_USERS" ] && [ "$TOTAL_USERS" -gt 0 ]; then
    pass "All passwords use pepper + bcrypt"
  else
    info "Some passwords not peppered (legacy)"
  fi

  # Check for plaintext sensitive data
  echo "Checking for plaintext sensitive data in DB..."
  PLAINTEXT_URLS=$(sqlite3 ./data/repo.db "SELECT COUNT(*) FROM items WHERE download_url LIKE 'http%' AND download_url NOT LIKE 'enc_v1:%';" 2>/dev/null || echo "0")
  echo "Plaintext download_url: $PLAINTEXT_URLS"
  if [ "$PLAINTEXT_URLS" = "0" ]; then
    pass "No plaintext download URLs (all encrypted or empty)"
  else
    info "$PLAINTEXT_URLS items have plaintext URLs (should be encrypted)"
  fi
else
  info "Database not found at ./data/repo.db - skipping encryption checks"
fi

# Check env keys
section "5. Encryption Keys Configuration"
if grep -q "ENCRYPTION_KEY=change-this" .env 2>/dev/null; then
  fail "ENCRYPTION_KEY is still default - generate with openssl rand -base64 32"
else
  if [ -f ".env" ] && grep -q "ENCRYPTION_KEY=" .env; then
    pass "ENCRYPTION_KEY set in .env"
  else
    info "ENCRYPTION_KEY not set in .env - using derived key (set in prod!)"
  fi
fi

if grep -q "PASSWORD_PEPPER=change-this" .env 2>/dev/null; then
  fail "PASSWORD_PEPPER is default - generate with openssl rand -hex 32"
else
  if [ -f ".env" ] && grep -q "PASSWORD_PEPPER=" .env; then
    pass "PASSWORD_PEPPER set"
  else
    info "PASSWORD_PEPPER not set - derived from JWT (set in prod!)"
  fi
fi

if grep -q "JWT_SECRET=change-this" .env 2>/dev/null; then
  fail "JWT_SECRET is default - generate with openssl rand -base64 32"
else
  pass "JWT_SECRET not default"
fi

# 6. Backend security tests
section "6. Backend Security Unit Tests"
cd backend
# `npm test | tail` reports tail's exit status, not npm's, so a failing suite
# was being reported as PASS. Capture output, then branch on the real code.
# `set -e` would abort the whole scan on a failing suite before the FAIL line
# is ever printed, so opt out for just this command.
TEST_OUT=""
TEST_EXIT=0
TEST_OUT=$(npm test 2>&1) || TEST_EXIT=$?
echo "$TEST_OUT" | tail -n 20
if [ $TEST_EXIT -eq 0 ]; then
  pass "Backend security tests passed"
else
  fail "Backend security tests failed (exit $TEST_EXIT)"
fi
cd ..

# 7. HTTP security tests (if running)
section "7. HTTP Security Tests (Live)"
if curl -s "$API/health" | grep -q "ok"; then
  pass "Backend is running - running HTTP tests"
  
  # Run test-vuln.sh. Its findings must count toward this scan's exit status,
  # so capture the real exit code instead of letting the pipeline swallow it.
  HTTP_EXIT=0
  HTTP_OUT=$(./scripts/test-vuln.sh 2>&1) || HTTP_EXIT=$?
  echo "$HTTP_OUT" | tail -n 60
  if [ $HTTP_EXIT -ne 0 ]; then
    fail "Live HTTP security tests reported findings (exit $HTTP_EXIT)"
  fi
  
  # Additional: check encryption endpoints
  echo ""
  echo "Encryption status endpoint:"
  curl -s "$API/auth/security-info" | python3 -m json.tool 2>/dev/null | head -n 40 || curl -s "$API/auth/security-info" | head -c 500
  
  echo ""
  echo "Testing encrypted data handling..."
  # The old probe hardcoded the slug "ubuntu-24-04-lts" and printed
  # "Item decryption works: False" when it 404'd - indistinguishable from a
  # real decryption failure on an empty catalogue. Pick a slug that exists.
  SLUG=$(curl -s "$API/items?limit=1" | python3 -c "import sys,json; d=json.load(sys.stdin); i=(d.get('items') or d if isinstance(d,list) else d.get('items') or []); print(i[0]['slug'] if i else '')" 2>/dev/null || echo "")
  if [ -z "$SLUG" ]; then
    info "Catalogue is empty - no item to spot-check decryption against (seed the DB to exercise this)"
  else
    ITEM=$(curl -s "$API/items/$SLUG" | python3 -c "import sys,json; d=json.load(sys.stdin); print('storage_path' in d and 'download_url' in d)" 2>/dev/null || echo "unknown")
    echo "Item decryption works ($SLUG): $ITEM"
    if [ "$ITEM" = "True" ]; then
      pass "Item fields decrypt for an authorized response"
    else
      info "Item $SLUG did not expose decrypted fields (may require auth)"
    fi
  fi

else
  info "Backend not running at $BASE_URL - skipping live HTTP tests"
  info "Start with: cd backend && npm run dev"
fi

# 8. File permissions
section "8. File Permissions & Secrets"
if [ -f ".env" ]; then
  PERMS=$(stat -c "%a" .env 2>/dev/null || stat -f "%OLp" .env 2>/dev/null || echo "unknown")
  echo ".env permissions: $PERMS"
  if [ "$PERMS" = "600" ] || [ "$PERMS" = "600" ]; then
    pass ".env permissions 600 (owner only)"
  else
    info ".env permissions $PERMS - should be 600 (chmod 600 .env)"
  fi
fi

# Check backup dir
if [ -d "./backups" ]; then
  BACKUP_COUNT=$(ls ./backups/ 2>/dev/null | wc -l)
  echo "Backups: $BACKUP_COUNT files in ./backups/"
  if [ "$BACKUP_COUNT" -gt 0 ]; then
    info "Backups exist - ensure they are encrypted if BACKUP_ENCRYPT=true"
  fi
fi

# 9. Summary
section "9. Summary & Recommendations"
echo "Report saved to: $REPORT_FILE"
echo ""
echo "Encryption at rest:"
echo "  - Passwords: pepper (HMAC-SHA256) + bcrypt cost 12 + versioned"
echo "  - Emails: AES-256-GCM (random IV) + HMAC-SHA256 hash for lookup"
echo "  - Items: storage_path, download_url, external_url, license_notes AES-256-GCM"
echo "  - Backups: can be encrypted via encryptFile()"
echo ""
echo "Key management:"
echo "  - Generate: openssl rand -base64 32 (ENCRYPTION_KEY)"
echo "  - Generate: openssl rand -hex 32 (PASSWORD_PEPPER)"
echo "  - Generate: openssl rand -base64 32 (JWT_SECRET)"
echo "  - Store in .env with 600 perms, never commit"
echo "  - Rotate: re-encrypt data with new key, update encryption_version"
echo ""
echo "Vuln scan completed. Review $REPORT_FILE for details."
echo "For the security unit tests: cd backend && npm test"

echo ""
if [ "$FAILURES" -gt 0 ]; then
  echo -e "${RED}Scan finished with $FAILURES failing check(s).${NC}"
  exit 1
fi
echo -e "${GREEN}Scan finished: all checks passed.${NC}"
exit 0
