#!/usr/bin/env bash
# Verifies the cuedu .env and its CRM connectivity. Read-only: creates no leads
# and writes no payments. Secrets are masked in all output.
APP_DIR="${1:-/var/www/cuedu}"

pass() { printf '  \033[32mPASS\033[0m %s\n' "$1"; }
fail() { printf '  \033[31mFAIL\033[0m %s\n' "$1"; }
warn() { printf '  \033[33mWARN\033[0m %s\n' "$1"; }
mask() { local v="$1"; [ ${#v} -le 8 ] && echo "<set,short>" || echo "${v:0:4}…${v: -4} (${#v} chars)"; }

echo "=== 1. Which .env does the running process use? ==="
CWD=$(pm2 describe cuedu 2>/dev/null | awk -F'│' '/exec cwd/{gsub(/ /,"",$3); print $3}')
if [ -n "$CWD" ]; then
  echo "  pm2 exec cwd: $CWD"
  ENV_FILE="$CWD/.env"
else
  warn "pm2 process 'cuedu' not found - falling back to $APP_DIR"
  ENV_FILE="$APP_DIR/.env"
fi
[ -f "$ENV_FILE" ] && pass "$ENV_FILE exists ($(stat -c '%y' "$ENV_FILE" 2>/dev/null | cut -d. -f1))" \
                   || { fail "$ENV_FILE MISSING - dotenv loads relative to cwd, so this is the file that counts"
                        ls -la "$APP_DIR"/.env "$APP_DIR"/backend/.env 2>/dev/null; }
[ -f "$ENV_FILE" ] || exit 1

set -a; . "$ENV_FILE" 2>/dev/null; set +a

echo
echo "=== 2. Required variables ==="
for v in CRM_WEBHOOK_URL CRM_LOOKUP_URL CRM_API_KEY CRM_PAYMENT_STATUS_URL CRM_PAYMENT_API_KEY PAYMENT_AMOUNT PORT; do
  val="${!v}"
  if [ -z "$val" ]; then
    case $v in
      CRM_WEBHOOK_URL) fail "$v is UNSET - registration will throw 'Failed to reach admissions'";;
      PORT|PAYMENT_AMOUNT) warn "$v unset (defaults apply: PORT=8000, amount=1000)";;
      *) warn "$v unset (code falls back to a hardcoded default)";;
    esac
  else
    case $v in *KEY*|*PASSWORD*) echo "  $v = $(mask "$val")";; *) echo "  $v = $val";; esac
  fi
done

echo
echo "=== 3. DNS for every CRM host referenced ==="
for u in "$CRM_WEBHOOK_URL" "$CRM_LOOKUP_URL" "$CRM_PAYMENT_STATUS_URL"; do
  [ -z "$u" ] && continue
  h=$(echo "$u" | awk -F[/:] '{print $4}')
  ip=$(getent hosts "$h" | awk '{print $1}' | tr '\n' ' ')
  [ -n "$ip" ] && pass "$h -> $ip" || fail "$h does NOT resolve - fetch will throw before any HTTP request"
done

echo
echo "=== 4. CRM endpoints (non-mutating) ==="
if [ -n "$CRM_PAYMENT_STATUS_URL" ]; then
  # No key: proves the route exists. Auth fails before any write.
  r=$(curl -s -m 10 -w '\n%{http_code}' -X POST "$CRM_PAYMENT_STATUS_URL" -H 'Content-Type: application/json' -d '{}')
  code=$(echo "$r" | tail -1)
  [ "$code" = "401" ] && pass "payment route exists (401 without key, as expected)" \
                      || fail "payment URL returned $code - expected 401. Check the path/host."
  # With key but no paymentId: a 400/422 means the key was accepted; still no write.
  r2=$(curl -s -m 10 -w '\n%{http_code}' -X POST "$CRM_PAYMENT_STATUS_URL" \
        -H 'Content-Type: application/json' -H "X-API-Key: $CRM_PAYMENT_API_KEY" -d '{}')
  c2=$(echo "$r2" | tail -1); b2=$(echo "$r2" | head -n -1)
  case "$c2" in
    401|403) fail "CRM_PAYMENT_API_KEY REJECTED ($c2): $b2";;
    400|422) pass "CRM_PAYMENT_API_KEY accepted (rejected on validation, not auth: $c2)";;
    *)       warn "key check returned $c2: $b2";;
  esac
fi
if [ -n "$CRM_LOOKUP_URL" ] && [ -n "$CRM_API_KEY" ]; then
  r3=$(curl -s -m 10 -w '\n%{http_code}' -H "X-API-Key: $CRM_API_KEY" "$CRM_LOOKUP_URL?mobile=0000000000")
  c3=$(echo "$r3" | tail -1)
  case "$c3" in
    401|403) fail "CRM_API_KEY rejected by lookup ($c3)";;
    *)       pass "lookup reachable and key accepted (HTTP $c3)";;
  esac
fi
echo "  NOTE: the inquiry POST endpoint is not probed - it would create a real lead."

echo
echo "=== 5. Is the RUNNING process using this .env? ==="
PID=$(pm2 pid cuedu 2>/dev/null)
if [ -n "$PID" ] && [ "$PID" != "0" ]; then
  running=$(tr '\0' '\n' < /proc/$PID/environ 2>/dev/null | grep '^CRM_WEBHOOK_URL=' | cut -d= -f2-)
  if [ -z "$running" ]; then
    warn "CRM_WEBHOOK_URL not in the process env (dotenv loads it at boot; this is normal)"
  elif [ "$running" = "$CRM_WEBHOOK_URL" ]; then
    pass "running process matches the .env"
  else
    fail "running process still has: $running  -> run: pm2 restart cuedu --update-env"
  fi
  started=$(pm2 describe cuedu 2>/dev/null | grep -i uptime)
  echo "  $started  (must be AFTER your .env edit)"
else
  warn "pm2 process 'cuedu' is not running"
fi

echo
echo "=== 6. App health + recent errors ==="
curl -s -m 5 "http://127.0.0.1:${PORT:-8000}/health" && echo || fail "app not responding on port ${PORT:-8000}"
LOG="${CWD:-$APP_DIR}/backend/logs/error.log"
[ -f "$LOG" ] || LOG="${CWD:-$APP_DIR}/logs/error.log"
if [ -f "$LOG" ]; then
  echo "  last 5 errors from $LOG:"
  tail -5 "$LOG" | sed 's/^/    /'
else
  echo "  no error log yet at $LOG"
fi
