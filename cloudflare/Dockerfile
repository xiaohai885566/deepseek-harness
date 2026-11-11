# syntax=docker/dockerfile:1.7
#
# DeepSeek Harness on Cloudflare Containers.
#
# The image is built from the repository root (wrangler's `build_context`), so
# every workspace package the harness composes is present. The harness is a
# Node program: its web profile owns a node:http listener, spawns shell tools,
# and loads a native addon, none of which run in a Worker isolate. The container
# is therefore the deployment unit and the Worker in front of it is a router.
#
# Build stage compiles the workspace exactly as CI does; runtime stage keeps the
# compiled tree, the shell tools the agent drives, and no compiler.

FROM node:24-bookworm-slim AS build

# CI=true makes the repository's postinstall hook skip git-hook installation:
# the image carries no .git, and a hook installer would fail the install.
ENV CI=true \
    DSH_TELEMETRY_DISABLED=1 \
    PNPM_HOME=/usr/local/bin \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates \
      git \
      python3 \
      make \
      g++ \
      pkg-config \
 && rm -rf /var/lib/apt/lists/*

# The repository pins packageManager pnpm@11.28.5; installing that exact version
# keeps the lockfile authoritative.
RUN npm install -g pnpm@11.28.5

WORKDIR /app
COPY . /app

# `--frozen-lockfile` fails the build instead of silently resolving new ranges.
RUN pnpm install --frozen-lockfile

# Artifacts only: the aggregate type-check and test programs are CI's job, and
# they add minutes to every image build without changing the output.
RUN pnpm run build:artifacts

FROM node:24-bookworm-slim AS runtime

ENV CI=true \
    NODE_ENV=production \
    DSH_TELEMETRY_DISABLED=1 \
    DSH_APP_ROOT=/app \
    DSH_HOME=/data/home \
    DSH_WORKSPACE=/workspace \
    DSH_EDGE_HOST=0.0.0.0 \
    DSH_EDGE_PORT=8080 \
    DSH_UPSTREAM_PORT=3080 \
    TZ=UTC

# The agent drives a real shell: git, ripgrep, and the usual text tools are the
# tools its prompts assume. No compiler, no package manager, no docker client.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      bash \
      ca-certificates \
      curl \
      git \
      jq \
      less \
      openssh-client \
      procps \
      ripgrep \
      unzip \
 && rm -rf /var/lib/apt/lists/* \
 && git config --system init.defaultBranch main \
 && git config --system advice.detachedHead false

COPY --from=build /app /app

# A first-run home directory and an empty workspace; the platform mounts neither,
# so both live on the instance disk and survive a stop while the instance lives.
RUN mkdir -p /data/home /workspace \
 && chmod +x /app/cloudflare/entrypoint.sh

WORKDIR /workspace
EXPOSE 8080

# The proxy spawns the harness itself, so the container has one process tree and
# one exit code. `exec` keeps SIGTERM reaching the proxy.
ENTRYPOINT ["/app/cloudflare/entrypoint.sh"]
