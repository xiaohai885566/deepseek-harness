#!/usr/bin/env bash
# Container entrypoint: prepare the persistent directories the harness expects,
# then hand the container port to the edge proxy. The proxy owns the listener
# lifecycle, so nothing here backgrounds a process.
set -euo pipefail

export DSH_HOME="${DSH_HOME:-/data/home}"
export DSH_WORKSPACE="${DSH_WORKSPACE:-/workspace}"
export DSH_EDGE_PORT="${DSH_EDGE_PORT:-8080}"
export DSH_UPSTREAM_PORT="${DSH_UPSTREAM_PORT:-3080}"
export DSH_APP_ROOT="${DSH_APP_ROOT:-/app}"
# The platform's own clock and locale are stable; the harness reads both for
# session timestamps and for the shell it gives the agent.
export TZ="${TZ:-UTC}"

mkdir -p "$DSH_HOME" "$DSH_WORKSPACE"

# A workspace without a repository makes every diff, status, and review tool
# answer "not a git repository"; initialize one once so the agent can work.
if [ ! -d "$DSH_WORKSPACE/.git" ]; then
  git -C "$DSH_WORKSPACE" init -q 2>/dev/null || true
  git -C "$DSH_WORKSPACE" config user.email "${GIT_AUTHOR_EMAIL:-dsh@container}" 2>/dev/null || true
  git -C "$DSH_WORKSPACE" config user.name "${GIT_AUTHOR_NAME:-DeepSeek Harness}" 2>/dev/null || true
fi

if [ -z "${DEEPSEEK_API_KEY:-}" ]; then
  echo "[entrypoint] DEEPSEEK_API_KEY is unset: the Web UI starts, but every model request fails until you set it" >&2
fi

echo "[entrypoint] home=$DSH_HOME workspace=$DSH_WORKSPACE port=$DSH_EDGE_PORT upstream=$DSH_UPSTREAM_PORT"

cd "$DSH_WORKSPACE"
exec node "$DSH_APP_ROOT/cloudflare/edge-proxy.mjs"
