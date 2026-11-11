#!/usr/bin/env bash
# Build the container image and deploy the Worker that fronts it.
#
# Wrangler builds `cloudflare/Dockerfile` with the local Docker daemon and pushes
# the layers to the Cloudflare registry, so Docker must be running here. The
# image build runs the repository's own artifact build, which takes a while the
# first time and reuses cached layers afterwards.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

fail() {
  printf '%s\n' "$1" >&2
  exit 1
}

command -v node >/dev/null 2>&1 || fail 'node is required (the harness build runs inside Docker, but wrangler runs here)'
command -v docker >/dev/null 2>&1 || fail 'docker is required: wrangler builds the container image locally'
docker info >/dev/null 2>&1 || fail 'the Docker daemon is not reachable; start Docker Desktop or colima and retry'

if ! npx --yes wrangler@4 whoami >/dev/null 2>&1; then
  fail 'wrangler is not authenticated; run: npx wrangler@4 login'
fi

if [ -n "${DEEPSEEK_API_KEY:-}" ]; then
  printf '%s' "$DEEPSEEK_API_KEY" | npx --yes wrangler@4 secret put DEEPSEEK_API_KEY
  echo 'stored secret DEEPSEEK_API_KEY'
else
  echo 'DEEPSEEK_API_KEY is unset: skipping the secret. The UI will load, but every model request fails until you run:'
  echo '  npx wrangler@4 secret put DEEPSEEK_API_KEY'
fi

if [ -n "${DSH_BASIC_AUTH:-}" ]; then
  printf '%s' "$DSH_BASIC_AUTH" | npx --yes wrangler@4 secret put DSH_BASIC_AUTH
  echo 'stored secret DSH_BASIC_AUTH (HTTP Basic gate in front of the deployment)'
fi

npx --yes wrangler@4 deploy "$@"
