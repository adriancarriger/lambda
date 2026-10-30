#!/usr/bin/env bash
# electron-builder rebuilds better-sqlite3 in place, for Electron (npmRebuild).
# In a workspace that copy is shared, so afterwards nothing running on plain
# Node (the CLI, the tests) could load it. build:mac runs this after
# electron-builder, whether or not that succeeded, to put the Node build back.
# It runs better-sqlite3's own install step: its prebuilt binary for this
# Node, else a source build.
set -euo pipefail

DIR="$(node -p "require('path').dirname(require.resolve('better-sqlite3/package.json'))")"

(cd "${DIR}" && npm run install --silent)

node -e "new (require('better-sqlite3'))(':memory:').close()"
echo "better-sqlite3: rebuilt for Node $(node -p 'process.version') ($(node -p 'process.arch'))"
