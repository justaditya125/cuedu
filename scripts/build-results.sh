#!/usr/bin/env bash
# One command from the result spreadsheets to a file the server can load.
#
#   scripts/build-results.sh "EXAM DATA University Format"
#
# Produces exam-data/results-mysql.sql (gitignored - it holds student data).
set -euo pipefail

SRC="${1:?usage: scripts/build-results.sh <folder with the .xlsx files>}"
HERE="$(cd "$(dirname "$0")" && pwd)"
OUT="$HERE/../exam-data"
mkdir -p "$OUT"

python3 -I "$HERE/import-results.py" "$SRC" "$OUT/results.db"
python3 -I "$HERE/export-mysql.py" "$OUT/results.db" "$OUT/results-mysql.sql"

echo
echo "Next: copy exam-data/results-mysql.sql to the server and load it:"
echo "  scp exam-data/results-mysql.sql root@SERVER:/root/results-mysql.sql"
echo "  ssh root@SERVER 'mysql cuedu_results < /root/results-mysql.sql && shred -u /root/results-mysql.sql'"
