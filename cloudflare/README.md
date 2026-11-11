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

## Free plan

**No.** Containers ship with the Workers paid plan ($5/month); a free account cannot create one, so the real-host path is closed to it.

What a free account can run is `cloudflare/static/`: static assets plus the host inside a browser Web Worker over an in-memory VFS, with no server process anywhere. The cost is concrete:

- **No real shell.** The `bash` tool runs inside the virtual filesystem: it cannot touch a host or clone a real repository.
- **No persistence.** A reload drops the session and the files with it, and the model credential must be entered again.
- **The key lives in the visitor's browser.** The browser calls `api.deepseek.com` directly; that endpoint answers `access-control-allow-origin: <your origin>`, so no proxy Worker is needed.
- **Asset limits.** 25 MiB per file, 20,000 files per deployment (the script checks before it deploys).

```sh
./cloudflare/static/deploy.sh      # pnpm install → build → build:preview → shape → wrangler deploy
```

To run the real host without paying Cloudflare, `cloudflare/Dockerfile` is a plain image: Koyeb, Render, Fly.io, Hugging Face Spaces, and Google Cloud Run all run the same one. Point the container port at 8080 and set `DEEPSEEK_API_KEY`. The `edge-proxy.mjs` layer is platform-independent; it only needs one listenable port inside the container.

## Access protection

The static deployment is **completely public** by default: an assets-only Worker has no server, so whoever has the URL has every byte. A password gate now sits in front (`cloudflare/worker/src/static-gate.ts`):

| Behaviour | Result |
| --- | --- |
| Any page without a session | 302 to `/__gate` (carrying `next`, so login returns there) |
| Any subresource without a session (JS/CSS/vfs image) | 401 JSON, not 200 |
| Correct password | 303 plus a `dsh_gate` cookie: `HttpOnly; Secure; SameSite=Lax`, HMAC-SHA256 signed, 30 days, no password inside |
| Wrong password | 401 with the same page; more than 10 tries locks for 60 seconds (counted per isolate, not globally) |
| `/__gate/logout` | clears the cookie |
| Rotating `DSH_SITE_SECRET` | invalidates every issued cookie |
| Neither secret configured | **fails closed**: every request answers 503 |

Change the password:

```sh
npx wrangler@4 secret put DSH_SITE_PASSWORD -c cloudflare/static/wrangler.jsonc
```

The cost: `run_worker_first: true` puts the Worker in front of every request, so assets count against the free 100,000 requests/day too. The gate protects the page, not the model credential, which always lives in the visitor's own browser.

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

That is the free-plan path above, split into its own directory: `cloudflare/static/wrangler.jsonc` (an assets-only Worker with no `main`, so it consumes no Worker requests) plus `cloudflare/static/deploy.sh`. Use the container deployment for the real thing.

## Troubleshooting

| Symptom | Cause |
| --- | --- |
| Worker returns 502 `harness listener unreachable` | The container runs but `dsh web` is not listening: read the container stdout through `wrangler tail` |
| The page 401s and `/__dsh/launch` 401s too | Wrong cookie audience or clock skew: clear cookies for the host and go through `/__dsh/launch` again |
| Permanent 503 | The proxy never saw the launch line: `dsh web` failed to start (a missing `DEEPSEEK_API_KEY` is not fatal; a missing dist is) |
| `wrangler deploy` hangs on image build | Docker is not running, or the first `node:24-bookworm-slim` pull is slow |
