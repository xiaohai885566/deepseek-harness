#!/usr/bin/env bash
# Build and deploy the browser-only harness to a free Cloudflare plan.
#
# `build:preview` emits a page that boots the host inside a browser Web Worker
# over an in-memory VFS, so the deployment is static files: no container, no
# Worker script, no secrets. The free plan's Workers assets host it as-is.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

fail() {
  printf '%s\n' "$1" >&2
  exit 1
}

# The workspace requires Node >= 24.9.0; an older runtime fails deep inside the
# build with an unrelated-looking error.
command -v node >/dev/null 2>&1 || fail 'node is required (24.9.0 or newer)'
node -e 'const [major, minor] = process.versions.node.split(".").map(Number); if (major < 24 || (major === 24 && minor < 9)) { console.error(`node ${process.versions.node} is too old; the workspace requires >=24.9.0`); process.exit(1) }'
command -v pnpm >/dev/null 2>&1 || fail 'pnpm is required: npm install -g pnpm@11.28.5'

pnpm install --frozen-lockfile
pnpm run build
pnpm --filter @deepseek-ai/dsh-web-frontend run build:preview

# Upstream's own shaping: sourcemaps carry complete sources and stay off the
# deployment platform, and index.html cannot boot without a host injecting
# window.__DSH_BOOT__, so the worker page becomes the served page.
find apps/web/dist -name '*.map' -delete
cp apps/web/dist/preview.html apps/web/dist/index.html

# Free-plan assets accept 25 MiB per file and 20,000 files per deployment. The
# packed VFS image is the one file that can exceed the size limit, and a deploy
# failure there names a byte count rather than a cause.
oversize="$(find apps/web/dist -type f -size +25M -print)"
if [ -n "$oversize" ]; then
  printf 'these files exceed the 25 MiB per-file limit:\n%s\n' "$oversize" >&2
  exit 1
fi

printf 'payload: %s in %s files\n' "$(du -sh apps/web/dist | cut -f1)" "$(find apps/web/dist -type f | wc -l | tr -d ' ')"
printf 'packed image: %s\n' "$(du -h apps/web/dist/preview/vfs-image.tar.gz 2>/dev/null | cut -f1 || echo 'missing')"

npx --yes wrangler@4 deploy -c cloudflare/static/wrangler.jsonc "$@"

cat <<'NOTE'

Verify two platform facts once the deploy prints its URL:
  1. the packed image is served without transport compression
       curl -sS -D - -o /dev/null -H 'Accept-Encoding: gzip' \
         https://<worker-host>/preview/vfs-image.tar.gz | grep -i content-encoding
     no output means the browser worker receives the gzip member it expects
  2. the page boots and the model answers after you enter your API key in
     Settings -> Models
NOTE
