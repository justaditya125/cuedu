#!/usr/bin/env bash
# Verifies the cuedu .env and its CRM connectivity. Read-only: creates no leads
# and writes no payments. Secrets are masked in all output.
# Defaults to the current directory; pass an explicit path to override.
APP_DIR="${1:-$(pwd)}"
# PM2 app name is auto-detected from the running process list, since it varies
# between deployments.
PM2_APP="${2:-}"

pass() { printf '  \033[32mPASS\033[0m %s\n' "$1"; }
fail() { printf '  \033[31mFAIL\033[0m %s\n' "$1"; }
warn() { printf '  \033[33mWARN\033[0m %s\n' "$1"; }
mask() { local v="$1"; [ ${#v} -le 8 ] && echo "<set,short>" || echo "${v:0:4}…${v: -4} (${#v} chars)"; }

echo "=== 1. Which .env does the running process use? ==="
# Find whichever PM2 app is running this project's server.js, whatever it is named.
DETECT=$(pm2 jlist 2>/dev/null | node -e '
let raw=""; process.stdin.on("data",d=>raw+=d).on("end",()=>{
  let list=[]; try { list=JSON.parse(raw)||[]; } catch(e) {}
  const hit=list.find(p=>/server\.js$/.test((p.pm2_env&&p.pm2_env.pm_exec_path)||""))||list[0];
  if(!hit) return;
  const e=hit.pm2_env||{};
  console.log([hit.name,e.pm_cwd||"",e.pm_exec_path||"",hit.pid||"",e.status||""].join("\t"));
});' 2>/dev/null)

if [ -n "$DETECT" ]; then
  PM2_APP=$(echo "$DETECT" | cut -f1)
  CWD=$(echo "$DETECT"    | cut -f2)
  SCRIPT=$(echo "$DETECT" | cut -f3)
  PMPID=$(echo "$DETECT"  | cut -f4)
  pass "pm2 app '$PM2_APP' (pid $PMPID)"
  echo "     script : $SCRIPT"
  echo "     cwd    : $CWD   <- dotenv reads .env from HERE"
  ENV_FILE="$CWD/.env"
else
  warn "no pm2 app found running a server.js - is the app started? try: pm2 list"
  CWD="$APP_DIR"
  ENV_FILE="$APP_DIR/.env"
fi
# If the detected cwd has no .env, check the other plausible spot before failing.
if [ ! -f "$ENV_FILE" ]; then
  for alt in "$APP_DIR/.env" "$APP_DIR/backend/.env" "$CWD/backend/.env"; do
    [ -f "$alt" ] && { warn "no .env at $ENV_FILE, but one exists at $alt"
                       warn "the app only reads the one in its cwd - move it, or restart from that dir"
                       ENV_FILE="$alt"; break; }
  done
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
PID="${PMPID:-$(pm2 pid "$PM2_APP" 2>/dev/null)}"
if [ -n "$PID" ] && [ "$PID" != "0" ]; then
  running=$(tr '\0' '\n' < /proc/$PID/environ 2>/dev/null | grep '^CRM_WEBHOOK_URL=' | cut -d= -f2-)
  if [ -z "$running" ]; then
    warn "CRM_WEBHOOK_URL not in the process env (dotenv loads it at boot; this is normal)"
  elif [ "$running" = "$CRM_WEBHOOK_URL" ]; then
    pass "running process matches the .env"
  else
    fail "running process still has: $running  -> run: pm2 restart $PM2_APP --update-env"
  fi
  started=$(pm2 describe "$PM2_APP" 2>/dev/null | grep -i uptime)
  echo "  $started  (must be AFTER your .env edit)"
else
  warn "pm2 app not running"
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
