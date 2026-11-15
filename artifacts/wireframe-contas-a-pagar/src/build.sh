#!/usr/bin/env bash
# Reconstrói artifacts/wireframe-contas-a-pagar/index.html a partir da main do shell e do barte-ui-kit.
# Uso: SHELL_REPO=… UIKIT_REPO=… KIT_DADOS=… ./build.sh   (UIKIT_REPO precisa de node_modules instalado)
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
work="$(mktemp -d)"
cp -r "$here/src" "$here/gen" "$here/vite.config.ts" "$here/index.html" "$work/"
mkdir -p "$work/vendor"
(cd "$SHELL_REPO" && git fetch -q origin main && git archive origin/main packages/kit/src) | tar x -C "$work/vendor"
(cd "$UIKIT_REPO" && git fetch -q origin main && git archive origin/main src) | tar x -C "$work/vendor" --transform 's,^src,uikit,'
(cd "$SHELL_REPO" && git show "origin/main:apps/shell/app/(shell)/settings/connections/connections.css") > "$work/src/connections.css"
ln -s "$UIKIT_REPO/node_modules" "$work/node_modules"
[ -n "${KIT_DADOS:-}" ] && python3 -I "$work/gen/data.py" "$KIT_DADOS" "$work/src/data.json"
(cd "$work" && node node_modules/vite/bin/vite.js build)
python3 -I "$work/gen/inline.py" "$work/dist" "$work/wireframe.html"
python3 -I "$work/gen/page.py" "$work/wireframe.html" "$here/../index.html"
