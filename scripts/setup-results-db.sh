#!/usr/bin/env bash
# One-time setup of the exam-results database for the "View My Results" feature.
#
#   bash /root/setup-results-db.sh
#
# You will be asked for the MySQL ROOT password (typed here, never stored). The
# script then:
#   1. creates the cuedu_results database and a SELECT-ONLY account for the app,
#      with a freshly generated password
#   2. loads the staged results-mysql.sql (atomic table swap)
#   3. writes the RESULTS_DB_* settings into the app's .env (after backing it up)
#   4. restarts the app and tests a real lookup
#   5. securely deletes the staged .sql file
#
# The app's password is generated on this machine and goes straight into .env;
# it is never printed.
set -euo pipefail

DB=cuedu_results
APPUSER=cuedu_results
SQLFILE=${SQLFILE:-/root/results-mysql.sql}
APP_DIR=${APP_DIR:-/opt/cuedu}
ENVFILE=$APP_DIR/backend/.env
APP=cuedu-backend

die() { echo "ERROR: $*" >&2; exit 1; }

[ "$(id -u)" = 0 ]    || die "run as root"
[ -f "$SQLFILE" ]     || die "$SQLFILE not found - upload it first"
[ -f "$ENVFILE" ]     || die "$ENVFILE not found"
# First run: create the account and configure the app. Any later run (a new
# release) only reloads the data - the account and its password are left alone.
if grep -q '^RESULTS_DB_NAME=' "$ENVFILE"; then MODE=reload; else MODE=setup; fi
echo "mode: $MODE"

# Credentials go in a private temp file, not on the command line (visible in `ps`).
CNF=$(mktemp); chmod 600 "$CNF"
OUT=$(mktemp)
trap 'rm -f "$CNF" "$OUT"' EXIT
if [ -n "${MYSQL_ADMIN_CNF:-}" ]; then
  # Opt-in: use an existing MySQL client config file instead of typing a password,
  # e.g. Ubuntu's maintenance account:  MYSQL_ADMIN_CNF=/etc/mysql/debian.cnf
  [ -r "$MYSQL_ADMIN_CNF" ] || die "cannot read $MYSQL_ADMIN_CNF"
  cp "$MYSQL_ADMIN_CNF" "$CNF"
  echo "using MySQL credentials from $MYSQL_ADMIN_CNF"
else
  read -r -s -p "MySQL root password: " ROOTPW; echo
  printf '[client]\nuser=root\npassword=%s\n' "$ROOTPW" > "$CNF"
  unset ROOTPW
fi
[ -n "${MYSQL_HOST:-}" ] && printf 'host=%s\nport=%s\n' "$MYSQL_HOST" "${MYSQL_PORT:-3306}" >> "$CNF"
if ! mysql --defaults-extra-file="$CNF" -e "SELECT 1" >/dev/null 2>&1; then
  echo "ERROR: MySQL login failed - nothing was changed." >&2
  echo "  - Retry and type the root password carefully (nothing is echoed as you type), or" >&2
  echo "  - use Ubuntu's maintenance account:  MYSQL_ADMIN_CNF=/etc/mysql/debian.cnf bash $0" >&2
  echo "  - or have a MySQL admin run the SQL in DEPLOY-UBUNTU.md Step 6.6." >&2
  exit 1
fi

if [ "$MODE" = setup ]; then
APPPW="$(openssl rand -base64 36 | tr -dc 'A-Za-z0-9' | cut -c1-28)"
[ ${#APPPW} -ge 24 ] || die "could not generate a password"

echo "1/5 creating database and read-only account..."
mysql --defaults-extra-file="$CNF" <<SQL
CREATE DATABASE IF NOT EXISTS $DB CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER IF NOT EXISTS '$APPUSER'@'localhost' IDENTIFIED BY '$APPPW';
CREATE USER IF NOT EXISTS '$APPUSER'@'127.0.0.1' IDENTIFIED BY '$APPPW';
ALTER USER '$APPUSER'@'localhost' IDENTIFIED BY '$APPPW';
ALTER USER '$APPUSER'@'127.0.0.1' IDENTIFIED BY '$APPPW';
GRANT SELECT ON $DB.* TO '$APPUSER'@'localhost';
GRANT SELECT ON $DB.* TO '$APPUSER'@'127.0.0.1';
SQL
fi

echo "2/5 loading the results..."
mysql --defaults-extra-file="$CNF" "$DB" < "$SQLFILE"

if [ "$MODE" = setup ]; then
echo "3/5 updating $ENVFILE (backup kept)..."
cp -p "$ENVFILE" "$ENVFILE.bak.$(date +%Y%m%d%H%M%S)"
{
  echo ""
  echo "# Exam results (View My Results) - added $(date +%F). SELECT-only MySQL account."
  echo "RESULTS_DB_HOST=${MYSQL_HOST:-127.0.0.1}"
  echo "RESULTS_DB_PORT=${MYSQL_PORT:-3306}"
  echo "RESULTS_DB_USER=$APPUSER"
  echo "RESULTS_DB_PASSWORD=$APPPW"
  echo "RESULTS_DB_NAME=$DB"
} >> "$ENVFILE"
unset APPPW
fi

echo "4/5 restarting the app and testing..."
pm2 restart "$APP" --update-env >/dev/null 2>&1
PORT=$(grep -E '^PORT=' "$ENVFILE" | tail -1 | cut -d= -f2); PORT=${PORT:-8000}
for i in $(seq 1 40); do curl -sf "http://127.0.0.1:$PORT/health" >/dev/null 2>&1 && break; sleep 0.5; done

REGN=$(mysql --defaults-extra-file="$CNF" "$DB" -N -e "SELECT enrollment_no FROM exam_students LIMIT 1")
OK=1
# Write the response to a file: piping a large PDF into `head` makes curl fail
# (exit 23), and with pipefail that would abort the script without a word.
curl -s -o "$OUT" -X POST "http://127.0.0.1:$PORT/api/results/memo" -H 'Content-Type: application/json' \
     -d "{\"regn\":\"$REGN\"}" || true
HEAD=$(head -c 5 "$OUT" || true)
[ "$HEAD" = "%PDF-" ] && echo "   real registration number  -> PDF            PASS" || { echo "   real registration number  -> FAIL (got: $HEAD)"; OK=0; }
CODE=$(curl -s -o /dev/null -w '%{http_code}' -X POST "http://127.0.0.1:$PORT/api/results/memo" \
       -H 'Content-Type: application/json' -d '{"regn":"000000000000"}')
[ "$CODE" = "404" ] && echo "   unknown number            -> 404            PASS" || { echo "   unknown number            -> $CODE  FAIL"; OK=0; }
sleep 1
# winston rotates at 5 MB and numbers the NEWEST file highest, so combined.log is the oldest.
NEWEST_LOG=$(ls -t "$APP_DIR"/backend/logs/combined*.log 2>/dev/null | head -1 || true)
[ -n "$NEWEST_LOG" ] && { grep -a "Results database" "$NEWEST_LOG" | tail -1 | sed 's/^/   log: /' || true; }

if [ "$OK" = 1 ]; then
  echo "5/5 removing the staged data file..."
  shred -u "$SQLFILE"
  echo; echo "DONE - View My Results is live."
else
  echo; echo "A test failed. The staged file was KEPT at $SQLFILE. See: pm2 logs $APP --lines 40 --nostream"
  exit 1
fi
