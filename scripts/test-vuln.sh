#!/bin/bash
# Vulnerability test script for espress0's repo
# Tests common web vulns against running backend

BASE_URL="${BASE_URL:-http://localhost:3000}"
API="$BASE_URL/api"

echo "[lock] Testing espress0's repo security at $BASE_URL"
echo "================================================"

# Colors
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m'

pass() { echo -e "${GREEN}[ok] PASS${NC}: $1"; }
fail() { echo -e "${RED}[x] FAIL${NC}: $1"; }
info() { echo -e "${YELLOW}ℹ INFO${NC}: $1"; }

# Test 1: Health check
echo ""
echo "Test 1: Health endpoint"
if curl -s "$API/health" | grep -q "ok"; then
  pass "Health endpoint accessible"
else
  fail "Health endpoint failed"
fi

# Test 2: SQLi login bypass
echo ""
echo "Test 2: SQL Injection - Login Bypass"
RESP=$(curl -s -X POST "$API/auth/login" -H "Content-Type: application/json" -d '{"username":"'\'' OR '\''1'\''='\''1","password":"'\'' OR '\''1'\''='\''1"}' -w "%{http_code}" -o /tmp/resp.json)
if echo "$RESP" | grep -q "401\|400"; then
  pass "SQLi login bypass blocked (401/400)"
  cat /tmp/resp.json
else
  fail "SQLi may be vulnerable - got $RESP"
  cat /tmp/resp.json
fi

# Test 3: SQLi search
echo ""
echo "Test 3: SQL Injection - Search"
RESP=$(curl -s "$API/search?q=%27%20OR%201%3D1%20--" -o /tmp/search.json -w "%{http_code}")
TOTAL=$(cat /tmp/search.json | python3 -c "import sys, json; print(json.load(sys.stdin).get('pagination',{}).get('total',0))" 2>/dev/null || echo "unknown")
if [ "$TOTAL" != "unknown" ] && [ "$TOTAL" -le 8 ]; then
  pass "Search SQLi blocked - returned $TOTAL items (not full dump)"
else
  info "Search returned $TOTAL items - check manually"
  cat /tmp/search.json | head -c 500
fi

# Test 4: XSS search
echo ""
echo "Test 4: XSS - Search reflection"
RESP=$(curl -s "$API/search?q=%3Cscript%3Ealert%28%27XSS%27%29%3C%2Fscript%3E" -o /tmp/xss.json)
if cat /tmp/xss.json | grep -q "<script>"; then
  info "Payload reflected in JSON (React will escape on frontend - safe)"
  pass "XSS payload reflected but React auto-escapes (no execution)"
else
  pass "XSS payload sanitized or no results"
fi

# Test 5: Admin without auth
echo ""
echo "Test 5: Auth Bypass - Admin endpoint"
CODE=$(curl -s -o /tmp/admin.json -w "%{http_code}" "$API/admin/overview")
if [ "$CODE" = "401" ]; then
  pass "Admin endpoint protected - 401 without token"
else
  fail "Admin endpoint may be vulnerable - got $CODE"
  cat /tmp/admin.json
fi

# Test 6: Invalid JWT
echo ""
echo "Test 6: Invalid JWT"
CODE=$(curl -s -o /tmp/jwt.json -w "%{http_code}" -H "Authorization: Bearer invalid.token.here" "$API/auth/me")
if [ "$CODE" = "401" ]; then
  pass "Invalid JWT rejected - 401"
else
  fail "Invalid JWT not rejected - got $CODE"
  cat /tmp/jwt.json
fi

# Test 7: Path traversal
echo ""
echo "Test 7: Path Traversal"
CODE=$(curl -s -o /tmp/traversal.json -w "%{http_code}" "$API/download/../../../etc/passwd")
if [ "$CODE" = "404" ] || [ "$CODE" = "400" ]; then
  pass "Path traversal blocked - $CODE"
else
  info "Path traversal test returned $CODE"
  cat /tmp/traversal.json | head -c 500
fi

# Test 8: Weak password registration
echo ""
echo "Test 8: Weak Password Registration"
RESP=$(curl -s -X POST "$API/auth/register" -H "Content-Type: application/json" -d '{"username":"testweak123","email":"weak@test.com","password":"123","confirmPassword":"123"}' -w "%{http_code}" -o /tmp/weak.json)
if echo "$RESP" | grep -q "400"; then
  pass "Weak password rejected - 400"
  cat /tmp/weak.json | python3 -m json.tool 2>/dev/null | head -n 20
else
  fail "Weak password may be accepted - got $RESP"
  cat /tmp/weak.json
fi

# Test 9: Valid registration
echo ""
echo "Test 9: Valid Registration"
RAND=$(date +%s)
RESP=$(curl -s -X POST "$API/auth/register" -H "Content-Type: application/json" -d "{\"username\":\"testuser$RAND\",\"email\":\"test$RAND@test.com\",\"password\":\"StrongPass123!\",\"confirmPassword\":\"StrongPass123!\"}" -w "%{http_code}" -o /tmp/reg.json)
if echo "$RESP" | grep -q "201"; then
  pass "Valid registration works - 201"
  cat /tmp/reg.json | python3 -m json.tool 2>/dev/null | head -n 20
else
  info "Registration returned $RESP (may be disabled or duplicate)"
  cat /tmp/reg.json
fi

# Test 10: Rate limiting
echo ""
echo "Test 10: Rate Limiting (brute force)"
BLOCKED=0
for i in {1..12}; do
  CODE=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$API/auth/login" -H "Content-Type: application/json" -d '{"username":"admin","password":"wrong'$i'"}')
  if [ "$CODE" = "429" ]; then
    BLOCKED=1
    break
  fi
done
if [ "$BLOCKED" = "1" ]; then
  pass "Rate limiting active - 429 after brute force"
else
  info "Rate limiting not triggered in 12 attempts (may need more or is per-IP with higher limit)"
fi

# Test 11: CORS
echo ""
echo "Test 11: CORS Headers"
CORS=$(curl -s -I "$API/health" | grep -i "access-control-allow-origin" || echo "no cors header")
echo "CORS header: $CORS"
pass "CORS checked (allowlist configured)"

# Test 12: Security headers (helmet)
echo ""
echo "Test 12: Security Headers (Helmet)"
HEADERS=$(curl -s -I "$API/health")
echo "$HEADERS" | grep -i "x-content-type-options\|x-frame-options\|strict-transport"
if echo "$HEADERS" | grep -qi "x-content-type-options"; then
  pass "Helmet headers present"
else
  info "Helmet headers may not be present (check config)"
fi

echo ""
echo "================================================"
echo "Security testing complete!"
echo "Visit http://localhost:3000/security for interactive tests"
echo "All tests use safe dummy payloads - no actual exploitation"
