#!/usr/bin/env bash
# bump-version.sh — aggiorna CACHE_NAME in sw.js e version.json prima di un deploy.
# Uso:
#   ./bump-version.sh                 # usa timestamp UTC corrente come versione
#   ./bump-version.sh 2026-05-04T22:30
#
# Output: modifica in-place sw.js e version.json. Non fa git commit.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
SW_FILE="$ROOT/sw.js"
VERSION_FILE="$ROOT/version.json"

if [ "${1:-}" != "" ]; then
  STAMP="$1"
else
  STAMP="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
fi

# CACHE_NAME usa una forma compressa (senza ":" e senza "Z") per essere safe nel nome cache.
CACHE_TAG="$(printf "%s" "$STAMP" | tr -d ':Z' | tr -d '-' )"
CACHE_NAME="listoapp-cache-v${CACHE_TAG}"

# Commit corto se in repo git, altrimenti "manual".
if git -C "$ROOT" rev-parse --short HEAD >/dev/null 2>&1; then
  COMMIT="$(git -C "$ROOT" rev-parse --short HEAD)"
else
  COMMIT="manual"
fi

# Aggiorna sw.js (riga: const CACHE_NAME = '...';)
if [ -f "$SW_FILE" ]; then
  # macOS sed vuole -i ''
  sed -i '' -E "s|^const CACHE_NAME = '[^']*';|const CACHE_NAME = '${CACHE_NAME}';|" "$SW_FILE"
  echo "sw.js -> CACHE_NAME = '${CACHE_NAME}'"
else
  echo "WARN: $SW_FILE non trovato"
fi

# Aggiorna version.json
cat > "$VERSION_FILE" <<EOF
{
  "version": "${STAMP}",
  "commit": "${COMMIT}"
}
EOF
echo "version.json -> ${STAMP} (${COMMIT})"
