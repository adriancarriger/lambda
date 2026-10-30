#!/usr/bin/env bash
# The last step of build:mac: electron-builder, then better-sqlite3 rebuilt
# for Node again, whether electron-builder worked or not (it rebuilds that
# module in place, for Electron, and in a workspace that copy is shared).
#
# With no Developer ID certificate (CSC_LINK), the whole bundle is ad-hoc
# signed. Left unsigned, an arm64 app keeps only Electron's own linker
# signature, which no longer matches the renamed bundle: a downloaded copy is
# then "damaged", with no Open Anyway. Either way the built app must pass
# codesign's strict check.
#
# Exits with electron-builder's status, else the check's, else the rebuild's.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP="desktop/release/mac-arm64/Lambda.app"

SIGN=()
if [[ -z "${CSC_LINK:-}" ]]; then
  SIGN=(-c.mac.identity=-)
fi

electron-builder --config desktop/electron-builder.yml --mac --arm64 --publish never \
  ${SIGN[@]+"${SIGN[@]}"} "$@"
built=$?

verified=0
if [[ ${built} -eq 0 ]]; then
  codesign --verify --deep --strict "${APP}"
  verified=$?
fi

# better-sqlite3's install step downloads and runs code: never with the
# signing secrets in its environment, nor the decoded notarisation key on
# disk (its path is predictable, and unsetting the variable leaves the file).
if [[ -n "${APPLE_API_KEY:-}" ]]; then
  rm -f "${APPLE_API_KEY}"
fi
env -u CSC_LINK -u CSC_KEY_PASSWORD -u APPLE_API_KEY -u APPLE_API_KEY_ID \
  -u APPLE_API_ISSUER -u APPLE_API_KEY_BASE64 \
  bash "${LAMBDA_REBUILD_FOR_NODE:-${HERE}/rebuild-for-node.sh}"
rebuilt=$?

if [[ ${built} -ne 0 ]]; then
  exit "${built}"
fi

if [[ ${verified} -ne 0 ]]; then
  echo "${APP} doesn't pass codesign --verify --deep --strict." >&2
  exit "${verified}"
fi

exit "${rebuilt}"
