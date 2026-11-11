/**
 * Cross-origin fetch, rerouted through this deployment's own origin.
 *
 * A browser build makes every model request as an ordinary `fetch`, so an
 * endpoint that sends no CORS headers — or one served over plain `http` from an
 * `https` page — is rejected by the browser before it reaches the network. The
 * rejection is an opaque `TypeError: Failed to fetch`, which the provider SDKs
 * report as the bare string `Connection error.`: no host, no status, no reason.
 *
 * A deployment can put a relay in front of that (`/__proxy/<upstream url>`; see
 * `cloudflare/worker/src/static-gate.ts`). Rather than ask every user to rewrite
 * their base URL, this wrapper does it at the one place all of them pass
 * through: `globalThis.fetch`. A cross-origin request is sent to the relay
 * instead, and the relay's own marker header says whether that worked. If the
 * deployment has no relay, the marker is absent and the request is retried
 * exactly as the caller wrote it, so a deployment without one behaves as before
 * and pays for one extra round trip, once.
 * @module experimental/webworker-runtime/fetch-relay
 */

/** Path the relay answers on, matching the static deployment's Worker. */
const RELAY_PATH = '/__proxy/'

/**
 * Response header every relay answer carries, success or refusal. Its presence
 * is what distinguishes "the relay exists and this is the upstream's real
 * answer" from "this deployment has no relay", without a probe request.
 */
const RELAY_MARKER = 'x-dsh-relay'

/** Whether the relay exists, once known. `undefined` until the first attempt. */
let relayAvailable: boolean | undefined

/**
 * The absolute URL a `fetch` call targets, when it has one.
 * @param input - the `fetch` first argument.
 * @returns the parsed URL, or `undefined` for something unparseable.
 */
function targetUrl(input: RequestInfo | URL): URL | undefined {
  const raw = typeof input === 'string'
    ? input
    : input instanceof URL
      ? input.href
      : (input as Request).url
  try {
    return new URL(raw, (globalThis as { location?: { href: string } }).location?.href)
  } catch {
    return undefined
  }
}

/**
 * Route cross-origin `fetch` calls through this origin's relay.
 *
 * Installed once, before anything that talks to a provider, so the provider
 * SDKs' `globalThis.fetch` lookup finds it. Same-origin and non-http(s) calls
 * are untouched: the app's own assets, its VFS image and overlays, and every
 * `data:`/`blob:` read keep their normal path.
 * @param path - the relay's path prefix, for a deployment that mounts it elsewhere.
 */
export function installFetchRelay(path: string = RELAY_PATH): void {
  const real = globalThis.fetch
  const location = (globalThis as { location?: { origin?: string; protocol?: string } }).location
  const origin = location?.origin
  if (typeof real !== 'function' || typeof origin !== 'string' || origin === 'null') return
  if (location?.protocol !== 'https:' && location?.protocol !== 'http:') return

  const toRelay = (target: URL): string => `${origin}${path}${target.href}`

  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const target = targetUrl(input)
    if (
      target === undefined
      // `data:`, `blob:` and every other scheme has no origin to relay from, and
      // the runtime resolves them itself.
      || (target.protocol !== 'https:' && target.protocol !== 'http:')
      || target.origin === origin
      || relayAvailable === false
    ) {
      return real(input, init)
    }
    const forwarded = input instanceof Request ? new Request(toRelay(target), input) : toRelay(target)
    const response = await real(forwarded, init)
    if (response.headers.has(RELAY_MARKER)) {
      relayAvailable = true
      return response
    }
    // No marker: this deployment serves no relay, so the rewrite reached the
    // static host instead of the endpoint. Answer the caller's own request.
    relayAvailable = false
    return real(input, init)
  }
}
