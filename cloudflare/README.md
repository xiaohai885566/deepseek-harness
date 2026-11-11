# Deploy DeepSeek Harness on Cloudflare

[中文](README.zh.md)

`dsh web` is a Node program: it owns a `node:http` listener, spawns shell tools, and loads a native addon (`native/system`). None of that exists in a Worker's V8 isolate, so the harness cannot be compiled into a Worker. The only Cloudflare form that runs the real host is **Containers**: the container runs the full `dsh web`, and the Worker in front of it only routes.

This directory is that layer. It changes no upstream package behaviour.

```
browser ──HTTPS/WSS──► Worker (cloudflare/worker/src/index.ts)
                        │  optional HTTP Basic gate
                        └─► Durable Object "main" (single instance: sessions + disk)
                              └─► Container:8080  cloudflare/edge-proxy.mjs
                                    └─► 127.0.0.1:3080  dsh web (the real host)
```

## Three problems this layer solves

| Problem | Handling | Where |
| --- | --- | --- |
| The `dsh web` Host/Origin fence accepts only loopback, the bind address, or `--trusted-host`, and the container's external name is unknown at listener start | The edge proxy rewrites `Host` to `127.0.0.1:3080` and `Origin` with it, so the fence always passes; `--public-url` stays display-only and grants no trust | `cloudflare/edge-proxy.mjs` |
| The launch URL carries a process credential that no entry point outside the container log knows | The proxy scrapes `dsh web: …?token=…` from stdout; both `GET /__dsh/launch` and an unauthenticated `/` redirect to `/?token=…`, and the listener mints the cookie itself | `cloudflare/edge-proxy.mjs` |
| Traffic forwarded before the plugin tree settles lands in a half-mounted host | `/health` answers 200 only after the launch line appears, and the Durable Object polls it before forwarding | `cloudflare/edge-proxy.mjs`, `cloudflare/worker/src/index.ts` |

## Prerequisites

- A Cloudflare account on the **Workers paid plan** (Containers are a paid feature) and its Account ID.
- **Docker** locally: `wrangler deploy` builds the image with the local daemon and pushes it to Cloudflare's own registry.
- Node.js 24 (only for wrangler; the image brings its own Node).

## Deploy

```sh
# 1. Authenticate
npx wrangler@4 login

# 2. Model credential (or let ./cloudflare/deploy.sh do it: DEEPSEEK_API_KEY=sk-xxx ./cloudflare/deploy.sh)
npx wrangler@4 secret put DEEPSEEK_API_KEY

# 3. Optional whole-site HTTP Basic gate (recommended without Access)
npx wrangler@4 secret put DSH_BASIC_AUTH      # enter user:password

# 4. Build the image and deploy the Worker (10–20 min the first time, then cached layers)
./cloudflare/deploy.sh
```

`wrangler deploy` reads `wrangler.jsonc` at the repository root, which hands the whole monorepo to `cloudflare/Dockerfile` through `build_context: "."`.

## After deploying

1. Open `https://<worker-host>/__dsh/launch`. It redirects to `/?token=…`; the listener mints the session cookie and the page loads.
2. The first request starts the container: expect a 1–3 minute cold start (the image already carries the build output, so nothing compiles at runtime).
3. Container logs: `npx wrangler@4 tail`, or Dashboard → Workers → Containers.

## Configuration

`vars` in `wrangler.jsonc`:

| Name | Default | Meaning |
| --- | --- | --- |
| `DSH_INSTANCE` | `standard-2` | 1 vCPU / 6 GiB / 12 GB disk. The image carries a full pnpm workspace, which does not fit standard-1's 8 GB disk |
| `DSH_IDLE_TIMEOUT_MS` | `7200000` | Idle time before the container stops. Raise it to avoid cold starts, lower it to cut cost |
| `DSH_PUBLIC_URL` | first request's origin | Display, `DSH_WEB_URL`, and the launch line only; it does not affect trust |

Secrets (`wrangler secret put`):

| Name | Meaning |
| --- | --- |
| `DEEPSEEK_API_KEY` | Model credential injected into the container at startup |
| `DSH_BASIC_AUTH` | `user:password` HTTP Basic gate at the Worker; unset disables it |
| `DSH_EDGE_KEY` | When set, `/__dsh/*` control endpoints require `?key=…` |
| `DSH_EXTRA_ENV` | JSON object of extra container environment variables, e.g. `{"HTTPS_PROXY":"http://…"}` |

## Known limitations (platform properties, not defects)

- **One instance.** `max_instances: 1` and every request enters the same Durable Object. Sessions, the workspace, and the cookie secret live on that one disk; a second instance would split one conversation across two filesystems.
- **Instance disk, not a persistent volume.** Once the platform recycles a stopped instance the filesystem returns to the image state. `/workspace` and `/data/home` survive a stop while the instance lives. For real persistence, mount an R2 bucket over FUSE (see Cloudflare's `r2-fuse-mount` example) or archive `/data` to R2 periodically.
- **Cost** follows container vCPU/memory/disk lifetime plus Worker requests. `DSH_IDLE_TIMEOUT_MS` is the most direct lever.
- **Large image.** A full workspace plus dependencies makes the first push slow; later deploys push changed layers only.
- **Publicly reachable.** The container runs an agent that executes arbitrary shell commands. Set `DSH_BASIC_AUTH`, or put the Worker host behind Cloudflare Access (Zero Trust).

## Alternative: browser-only build (no container)

The repository already ships `pnpm --filter @deepseek-ai/dsh-web-frontend run build:preview`, whose output runs the host inside a browser Web Worker over an in-memory VFS and deploys as static files (`wrangler pages deploy apps/web/dist`). The cost: no real shell, no real filesystem, the model key lives in the browser, and the browser must reach the model API directly (CORS applies). Use the container deployment above for the real thing.

## Troubleshooting

| Symptom | Cause |
| --- | --- |
| Worker returns 502 `harness listener unreachable` | The container runs but `dsh web` is not listening: read the container stdout through `wrangler tail` |
| The page 401s and `/__dsh/launch` 401s too | Wrong cookie audience or clock skew: clear cookies for the host and go through `/__dsh/launch` again |
| Permanent 503 | The proxy never saw the launch line: `dsh web` failed to start (a missing `DEEPSEEK_API_KEY` is not fatal; a missing dist is) |
| `wrangler deploy` hangs on image build | Docker is not running, or the first `node:24-bookworm-slim` pull is slow |
