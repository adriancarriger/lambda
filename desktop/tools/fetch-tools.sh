#!/usr/bin/env bash
# Builds the tmux and git the Mac app carries, into desktop/tools/out (which
# electron-builder copies to Lambda.app/Contents/Resources/tools).
#
# Neither ships as a standalone macOS binary, and /usr/bin/git is only a stub
# that asks to install the Xcode tools, so both are built from pinned source
# tarballs, each checked against its SHA-256 (a mismatch stops the build).
# tmux is linked against a static libevent and the system ncurses; git is
# built with RUNTIME_PREFIX so it runs from wherever the app is. Needs the
# Xcode command line tools (the macOS release runner has them).
#
# Ends by checking that each binary links only /usr/lib and /System
# libraries, so it runs on a Mac with nothing else installed. Everything is
# built in .work/out and moves to out/ only once every check has passed, so
# a failed run never leaves binaries the next run takes as already built.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT="${HERE}/out"
WORK="${HERE}/.work"
STAGE="${WORK}/out"

TMUX_VERSION="3.5a"
TMUX_SHA256="16216bd0877170dfcc64157085ba9013610b12b082548c7c9542cc0103198951"
LIBEVENT_VERSION="2.1.12-stable"
LIBEVENT_SHA256="92e6de1be9ec176428fd2367677e61ceffc2ee1cb119035037a27d346b0403bb"
GIT_VERSION="2.47.3"
GIT_SHA256="c073471530e92b716641ea2b381fcd0ece53eea9a76a9c5415f93f89e870dd5f"

JOBS="$(sysctl -n hw.ncpu 2>/dev/null || echo 4)"
export MACOSX_DEPLOYMENT_TARGET="${MACOSX_DEPLOYMENT_TARGET:-12.0}"

if [[ -x "${OUT}/bin/tmux" && -x "${OUT}/bin/git" && "${1:-}" != "--force" ]]; then
  echo "tools: already built in ${OUT} (--force to rebuild)"
  exit 0
fi

fetch() {
  local url="$1" file="$2" sha="$3"

  if [[ ! -f "${WORK}/${file}" ]]; then
    curl -fsSL --retry 3 -o "${WORK}/${file}.part" "${url}"
    mv "${WORK}/${file}.part" "${WORK}/${file}"
  fi

  local actual
  actual="$(shasum -a 256 "${WORK}/${file}" | awk '{print $1}')"

  if [[ "${actual}" != "${sha}" ]]; then
    echo "tools: ${file} has SHA-256 ${actual}, expected ${sha}" >&2
    rm -f "${WORK}/${file}"
    exit 1
  fi

  tar -xzf "${WORK}/${file}" -C "${WORK}"
}

rm -rf "${OUT}" "${STAGE}"
mkdir -p "${WORK}" "${STAGE}/bin"

# ── libevent (static, for tmux only) ──────────────────────────────────────
fetch "https://github.com/libevent/libevent/releases/download/release-${LIBEVENT_VERSION}/libevent-${LIBEVENT_VERSION}.tar.gz" \
  "libevent-${LIBEVENT_VERSION}.tar.gz" "${LIBEVENT_SHA256}"
(
  cd "${WORK}/libevent-${LIBEVENT_VERSION}"
  ./configure --prefix="${WORK}/libevent" --disable-shared --enable-static \
    --disable-openssl --disable-samples --disable-libevent-regress >/dev/null
  make -j"${JOBS}" >/dev/null
  make install >/dev/null
)

# ── tmux ─────────────────────────────────────────────────────────────────
fetch "https://github.com/tmux/tmux/releases/download/${TMUX_VERSION}/tmux-${TMUX_VERSION}.tar.gz" \
  "tmux-${TMUX_VERSION}.tar.gz" "${TMUX_SHA256}"
(
  cd "${WORK}/tmux-${TMUX_VERSION}"
  # Only our libevent: pkg-config never sees another one (Homebrew's, say).
  PKG_CONFIG_LIBDIR="${WORK}/libevent/lib/pkgconfig" PKG_CONFIG_PATH="" \
    ./configure --prefix="${WORK}/tmux" --disable-utf8proc \
    LIBEVENT_CORE_CFLAGS="-I${WORK}/libevent/include" \
    LIBEVENT_CORE_LIBS="${WORK}/libevent/lib/libevent_core.a" \
    LIBNCURSES_CFLAGS="" LIBNCURSES_LIBS="-lncurses" >/dev/null
  make -j"${JOBS}" >/dev/null
  cp tmux "${STAGE}/bin/tmux"
)

# ── git ──────────────────────────────────────────────────────────────────
fetch "https://mirrors.edge.kernel.org/pub/software/scm/git/git-${GIT_VERSION}.tar.gz" \
  "git-${GIT_VERSION}.tar.gz" "${GIT_SHA256}"
(
  cd "${WORK}/git-${GIT_VERSION}"
  make -j"${JOBS}" prefix=/ RUNTIME_PREFIX=YesPlease NO_GETTEXT=YesPlease \
    NO_TCLTK=YesPlease NO_PERL=YesPlease NO_PYTHON=YesPlease \
    NO_OPENSSL=YesPlease NO_DARWIN_PORTS=YesPlease NO_FINK=YesPlease \
    NO_INSTALL_HARDLINKS=YesPlease SKIP_DASHED_BUILT_INS=YesPlease >/dev/null
  make prefix=/ RUNTIME_PREFIX=YesPlease NO_GETTEXT=YesPlease \
    NO_TCLTK=YesPlease NO_PERL=YesPlease NO_PYTHON=YesPlease \
    NO_OPENSSL=YesPlease NO_DARWIN_PORTS=YesPlease NO_FINK=YesPlease \
    NO_INSTALL_HARDLINKS=YesPlease SKIP_DASHED_BUILT_INS=YesPlease DESTDIR="${WORK}/git" install >/dev/null
)
cp "${WORK}/git/bin/git" "${STAGE}/bin/git"
mkdir -p "${STAGE}/libexec"
cp -R "${WORK}/git/libexec/git-core" "${STAGE}/libexec/git-core"
mkdir -p "${STAGE}/share"
cp -R "${WORK}/git/share/git-core" "${STAGE}/share/git-core"

# ── only system libraries ────────────────────────────────────────────────
check_links() {
  local binary="$1"
  local foreign
  foreign="$(otool -L "${binary}" | tail -n +2 | awk '{print $1}' |
    grep -v -E '^(/usr/lib/|/System/)' || true)"

  if [[ -n "${foreign}" ]]; then
    echo "tools: ${binary} links outside /usr/lib and /System:" >&2
    echo "${foreign}" >&2
    exit 1
  fi
}

check_links "${STAGE}/bin/tmux"
check_links "${STAGE}/bin/git"
find "${STAGE}/libexec/git-core" -type f -perm -u+x | while read -r helper; do
  if file "${helper}" | grep -q 'Mach-O'; then
    check_links "${helper}"
  fi
done

mv "${STAGE}" "${OUT}"
echo "tools: tmux ${TMUX_VERSION} and git ${GIT_VERSION} in ${OUT}"
