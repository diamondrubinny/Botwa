#!/usr/bin/env bash
# Build release/botwa-install.tar.gz (+ .sha256) from the committed tree - copy to the server with scp.
set -euo pipefail
cd "$(dirname "$0")/.."
git diff --quiet && git diff --cached --quiet || { echo "Commit your changes first (the package is built from HEAD)" >&2; exit 1; }
mkdir -p release
git archive --format=tar.gz --prefix=botwa/ -o release/botwa-install.tar.gz HEAD
( cd release && sha256sum botwa-install.tar.gz > botwa-install.tar.gz.sha256 )
echo "built: release/botwa-install.tar.gz"; cat release/botwa-install.tar.gz.sha256
