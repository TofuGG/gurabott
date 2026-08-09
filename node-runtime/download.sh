#!/usr/bin/env bash
# Downloads and extracts a project-local portable Node 26 into node-runtime/.
# Linux/macOS twin of node-runtime/download.ps1.
#
# The OpenTUI UI needs Node >= 26 (experimental `node:ffi`); `npm start` uses
# this runtime so your system Node version doesn't matter.
set -euo pipefail

VERSION="v26.6.0"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ── Detect OS + arch → Node tarball triple ────────────────────────────────────
OS="$(uname -s)"
ARCH="$(uname -m)"

case "$OS" in
  Linux)  OS_TRIPLE="linux" ;;
  Darwin) OS_TRIPLE="darwin" ;;
  *)
    echo "❌ Unsupported OS: $OS (only Linux and macOS are supported)."
    exit 1
    ;;
esac

case "$ARCH" in
  x86_64|amd64)  ARCH_TRIPLE="x64" ;;
  aarch64|arm64) ARCH_TRIPLE="arm64" ;;
  *)
    echo "❌ Unsupported architecture: $ARCH (only x64 and arm64 are supported)."
    exit 1
    ;;
esac

DIR="$SCRIPT_DIR/node-$VERSION-$OS_TRIPLE-$ARCH_TRIPLE"
ARCHIVE="$SCRIPT_DIR/node-$VERSION-$OS_TRIPLE-$ARCH_TRIPLE.tar.gz"
URL="https://nodejs.org/dist/$VERSION/node-$VERSION-$OS_TRIPLE-$ARCH_TRIPLE.tar.gz"

if [ -x "$DIR/bin/node" ]; then
  echo "✅ Portable Node $VERSION already present at $DIR"
  exit 0
fi

echo "Downloading $URL ..."
if command -v curl >/dev/null 2>&1; then
  curl -fL --user-agent "gura" -o "$ARCHIVE" "$URL"
elif command -v wget >/dev/null 2>&1; then
  wget -O "$ARCHIVE" "$URL"
else
  echo "❌ Neither curl nor wget found — install one of them and re-run."
  exit 1
fi

echo "Extracting to $SCRIPT_DIR ..."
tar -xzf "$ARCHIVE" -C "$SCRIPT_DIR"
rm -f "$ARCHIVE"

"$DIR/bin/node" --version
echo "✅ Ready. Run 'npm start'."
