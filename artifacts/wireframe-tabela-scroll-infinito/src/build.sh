#!/usr/bin/env bash
# Reconstrói artifacts/wireframe-tabela-scroll-infinito/index.html.
# Usa os pacotes que o portal usa de verdade (web/node_modules: shell-kit, barte-ui-kit 0.2.0, barte-design-system 0.1.69)
# e as grids de web/src (RowTable, Screen, GridFilter, GridBadge, InvoiceCell, EmptyState, textos), para a tela ter a cara de hoje.
# Pré-requisito: `NODE_AUTH_TOKEN=$(gh auth token) npm --prefix web ci`. Uso: artifacts/wireframe-tabela-scroll-infinito/src/build.sh
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
web="$(cd "$here/../../../web" && pwd)"
[ -d "$web/node_modules/vite" ] || { echo "falta web/node_modules: rode npm --prefix web ci" >&2; exit 1; }
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
cp -r "$here/src" "$here/gen" "$here/vite.config.ts" "$here/index.html" "$work/"
ln -s "$web/node_modules" "$work/node_modules"
(cd "$work" && WEB_SRC="$web/src" node node_modules/vite/bin/vite.js build)
python3 -I "$work/gen/inline.py" "$work/dist" "$work/wireframe.html"
python3 -I "$work/gen/page.py" "$work/wireframe.html" "$here/../index.html"
