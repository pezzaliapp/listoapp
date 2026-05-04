#!/usr/bin/env bash
set -eo pipefail

UPDATE=0
[ "${1:-}" = "--update" ] && UPDATE=1

VENDORS=(
  "xlsx|https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js|sha512-PLACEHOLDER-xlsx-0.18.5"
  "jspdf|https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js|sha512-PLACEHOLDER-jspdf-2.5.1"
)

TMPDIR=$(mktemp -d)
trap 'rm -rf "$TMPDIR"' EXIT

for entry in "${VENDORS[@]}"; do
  IFS='|' read -r name url placeholder <<< "$entry"
  echo "→ $name"
  echo "  url: $url"
  curl -sSL "$url" -o "$TMPDIR/$name.js"
  HASH=$(openssl dgst -sha512 -binary "$TMPDIR/$name.js" | openssl base64 -A)
  SRI="sha512-$HASH"
  echo "  sri: $SRI"
  if [ "$UPDATE" = "1" ]; then
    sed -i '' "s|$placeholder|$SRI|g" assets/app.js
    echo "  ✓ aggiornato in assets/app.js"
  fi
  echo ""
done

echo "Fatto."
