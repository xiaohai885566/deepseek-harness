/**
 * Password gate for the static deployment.
 *
 * The assets are a complete client-side app, so an unauthenticated visitor gets
 * the same bytes an authenticated one does. Gating therefore has to happen in
 * front of the asset layer: this Worker runs first for every path, and only a
 * request carrying a valid signed cookie reaches `env.ASSETS`.
 *
 * The cookie is an expiry plus an HMAC over it, keyed by `DSH_SITE_SECRET`, so a
 * client cannot mint one and a password change (which rotates the secret) ends
 * every session. The password itself is never stored in the cookie.
 * @module cloudflare/worker/src/static-gate
 */

/** Bindings this Worker reads. */
interface Env {
  /** The static asset layer holding the built browser app. */
  ASSETS: Fetcher
  /** Visitor-facing password. Unset means the gate refuses every request. */
  DSH_SITE_PASSWORD?: string
  /** HMAC key for session cookies. Rotating it invalidates every session. */
  DSH_SITE_SECRET?: string
  /**
   * Optional comma-separated host allowlist for the model relay. Empty or unset
   * forwards to any host, which is the right default for a single-operator
   * deployment behind the password; set it to keep a shared deployment from
   * becoming an open proxy.
   */
  DSH_PROXY_ALLOW?: string
}

const COOKIE_NAME = 'dsh_gate'
const GATE_PATH = '/__gate'
const LOGOUT_PATH = '/__gate/logout'
/**
 * Same-origin relay for model endpoints.
 *
 * The harness runs in a browser worker, so every model request is an ordinary
 * cross-origin `fetch`: an endpoint that sends no CORS headers, or one served
 * over plain `http` from an `https` page, fails with the OpenAI SDK's bare
 * "Connection error." A base URL of
 * `<this deployment>/__proxy/https://endpoint/v1` puts the request back on this
 * origin and lets the Worker make the outbound call instead.
 */
const PROXY_PATH = '/__proxy/'

/**
 * Header every relay answer carries, success or refusal. The browser-side
 * wrapper (`webworker-runtime/src/fetch-relay.ts`) keys off it to tell "this is
 * the endpoint's real answer" from "this deployment has no relay", so a
 * deployment without one keeps its direct cross-origin requests.
 */
const PROXY_MARKER = 'x-dsh-relay'
const SESSION_SECONDS = 60 * 60 * 24 * 30
const LOCK_AFTER = 10
const LOCK_WINDOW_MS = 60_000

/**
 * Recent failures per client address. A Worker isolate keeps its own copy, so
 * this raises the cost of guessing without pretending to be a global limiter.
 */
const failures = new Map<string, { count: number; resetAt: number }>()

const encoder = new TextEncoder()

/** Base64url without padding, the only alphabet a cookie value needs. */
function base64url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')
}

/** HMAC-SHA-256 over a message, as raw bytes. */
async function hmac(secret: string, message: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(message)))
}

/**
 * Compare two strings without leaking their contents through timing.
 * @returns whether they are equal.
 */
function constantTimeEqual(left: string, right: string): boolean {
  const a = encoder.encode(left)
  const b = encoder.encode(right)
  let difference = a.length ^ b.length
  const length = Math.max(a.length, b.length)
  for (let index = 0; index < length; index += 1) {
    difference |= (a[index] ?? 0) ^ (b[index] ?? 0)
  }
  return difference === 0
}

/**
 * Compare a submitted password against the configured one.
 *
 * Both sides go through the same HMAC first, so the comparison is over fixed
 * length digests and reveals neither the password's length nor its prefix.
 * @returns whether the submission is the configured password.
 */
async function passwordMatches(secret: string, configured: string, submitted: string): Promise<boolean> {
  const [expected, actual] = await Promise.all([hmac(secret, configured), hmac(secret, submitted)])
  return constantTimeEqual(base64url(expected), base64url(actual))
}

/** Read one cookie value out of the request headers. */
function readCookie(request: Request, name: string): string | undefined {
  const header = request.headers.get('cookie')
  if (header === null) return undefined
  for (const part of header.split(';')) {
    const separator = part.indexOf('=')
    if (separator < 0) continue
    if (part.slice(0, separator).trim() === name) return part.slice(separator + 1).trim()
  }
  return undefined
}

/**
 * Decide whether a request carries a live session cookie.
 * @returns true when the signature verifies and the expiry is in the future.
 */
async function hasSession(request: Request, secret: string): Promise<boolean> {
  const value = readCookie(request, COOKIE_NAME)
  if (value === undefined) return false
  const separator = value.indexOf('.')
  if (separator < 0) return false
  const expires = Number(value.slice(0, separator))
  if (!Number.isFinite(expires) || expires <= Date.now() / 1000) return false
  const signature = await hmac(secret, String(expires))
  return constantTimeEqual(base64url(signature), value.slice(separator + 1))
}

/** Mint the session cookie for a successful login. */
async function issueSession(secret: string): Promise<string> {
  const expires = Math.floor(Date.now() / 1000) + SESSION_SECONDS
  const signature = base64url(await hmac(secret, String(expires)))
  return [
    `${COOKIE_NAME}=${expires}.${signature}`,
    'Path=/',
    `Max-Age=${SESSION_SECONDS}`,
    'HttpOnly',
    'Secure',
    'SameSite=Lax',
  ].join('; ')
}

/**
 * Accept only a same-site path as the post-login destination, so the gate
 * cannot be used as an open redirect.
 */
function safeNext(raw: string | null): string {
  if (raw === null || !raw.startsWith('/') || raw.startsWith('//')) return '/'
  return raw
}

/** Whether the client asked for a document rather than a subresource. */
function wantsHtml(request: Request): boolean {
  const mode = request.headers.get('sec-fetch-mode')
  if (mode === 'navigate') return true
  return (request.headers.get('accept') ?? '').includes('text/html')
}

/** The login page, with an optional error line. */
function loginPage(next: string, message = ''): Response {
  const body = `<!doctype html>
<html lang="zh">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>DeepSeek Harness · 访问密码</title>
    <style>
      :root { color-scheme: dark }
      * { box-sizing: border-box }
      body {
        margin: 0; min-height: 100dvh; display: grid; place-items: center;
        background: #0b0d10; color: #e6e8eb;
        font: 15px/1.5 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
      }
      form { width: min(92vw, 340px); display: grid; gap: 14px }
      h1 { margin: 0 0 4px; font-size: 17px; font-weight: 600 }
      p { margin: 0; color: #9aa3ad; font-size: 13px }
      input {
        width: 100%; padding: 11px 13px; border-radius: 9px;
        border: 1px solid #2a2f37; background: #14171c; color: inherit; font: inherit;
      }
      input:focus { outline: 2px solid #3b82f6; outline-offset: 1px }
      button {
        padding: 11px 13px; border-radius: 9px; border: 0; cursor: pointer;
        background: #2563eb; color: #fff; font: inherit; font-weight: 600;
      }
      button:hover { background: #1d4ed8 }
      .error { color: #f87171; font-size: 13px; min-height: 18px }
    </style>
  </head>
  <body>
    <form method="post" action="${GATE_PATH}">
      <h1>DeepSeek Harness</h1>
      <p>这个部署需要访问密码。</p>
      <input type="password" name="password" placeholder="访问密码" autocomplete="current-password" autofocus required />
      <input type="hidden" name="next" value="${next.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;')}" />
      <div class="error">${message}</div>
      <button type="submit">进入</button>
    </form>
  </body>
</html>`
  return new Response(body, {
    status: message === '' ? 200 : 401,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'x-frame-options': 'DENY',
      'referrer-policy': 'same-origin',
    },
  })
}

/** Redirect a browser to the login page, remembering where it was going. */
function toGate(url: URL): Response {
  const next = `${url.pathname}${url.search}`
  const target = next === '/' ? GATE_PATH : `${GATE_PATH}?next=${encodeURIComponent(next)}`
  return new Response(null, { status: 302, headers: { location: target, 'cache-control': 'no-store' } })
}

/** Read the client address the platform observed. */
function clientKey(request: Request): string {
  return request.headers.get('cf-connecting-ip') ?? 'unknown'
}

/** Record a failure and report whether this client is now locked out. */
function recordFailure(key: string): boolean {
  const now = Date.now()
  const entry = failures.get(key)
  if (entry === undefined || entry.resetAt <= now) {
    failures.set(key, { count: 1, resetAt: now + LOCK_WINDOW_MS })
    return false
  }
  entry.count += 1
  return entry.count > LOCK_AFTER
}

/** Whether this client is inside a lockout window. */
function isLocked(key: string): boolean {
  const entry = failures.get(key)
  if (entry === undefined) return false
  if (entry.resetAt <= Date.now()) {
    failures.delete(key)
    return false
  }
  return entry.count > LOCK_AFTER
}

/** Handle `GET`/`POST /__gate`. */
async function handleGate(request: Request, url: URL, env: Env): Promise<Response> {
  const password = env.DSH_SITE_PASSWORD as string
  const secret = env.DSH_SITE_SECRET as string
  const key = clientKey(request)

  if (request.method === 'GET') {
    if (await hasSession(request, secret)) {
      return new Response(null, { status: 303, headers: { location: safeNext(url.searchParams.get('next')) } })
    }
    return loginPage(safeNext(url.searchParams.get('next')))
  }
  if (request.method !== 'POST') {
    return new Response('method not allowed', { status: 405, headers: { allow: 'GET, POST' } })
  }
  if (isLocked(key)) {
    return loginPage('/', '尝试次数过多，请一分钟后再试。')
  }

  const form = await request.formData()
  const submitted = String(form.get('password') ?? '')
  const next = safeNext(String(form.get('next') ?? '/'))
  if (!await passwordMatches(secret, password, submitted)) {
    const locked = recordFailure(key)
    return loginPage(next, locked ? '尝试次数过多，请一分钟后再试。' : '密码不对。')
  }

  failures.delete(key)
  return new Response(null, {
    status: 303,
    headers: {
      location: next,
      'set-cookie': await issueSession(secret),
      'cache-control': 'no-store',
    },
  })
}

/** Clear the session cookie. */
function handleLogout(): Response {
  return new Response(null, {
    status: 303,
    headers: {
      location: GATE_PATH,
      'set-cookie': `${COOKIE_NAME}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`,
      'cache-control': 'no-store',
    },
  })
}

/** Request headers the relay carries to the endpoint, and nothing else. */
const FORWARDED_HEADERS: readonly string[] = [
  'authorization', 'x-api-key', 'content-type', 'accept', 'user-agent',
  'anthropic-version', 'anthropic-beta', 'anthropic-dangerous-direct-browser-access',
  'openai-organization', 'openai-project', 'openai-beta',
]

/**
 * Response headers the relay drops: hop-by-hop framing, and the encoding the
 * runtime already undid. The browser's own CORS policy does not apply to a
 * same-origin response, so an upstream `access-control-*` value is noise here.
 */
const DROPPED_HEADERS: readonly string[] = [
  'content-encoding', 'content-length', 'transfer-encoding', 'connection', 'keep-alive',
  'set-cookie', 'access-control-allow-origin', 'access-control-allow-headers',
  'access-control-allow-methods', 'access-control-expose-headers',
]

/**
 * Relay one model request to the endpoint named in the path.
 *
 * The body is passed through as a stream in both directions, so an SSE
 * completion reaches the page event by event instead of after the last token.
 * @param request - the same-origin request from the harness.
 * @param url - its URL, whose path after {@link PROXY_PATH} is the endpoint URL.
 * @param env - the host allowlist, when one is configured.
 * @returns the endpoint's response, or a refusal naming what was wrong.
 */
async function handleProxy(request: Request, url: URL, env: Env): Promise<Response> {
  const target = url.pathname.slice(PROXY_PATH.length) + url.search
  let upstream: URL
  try {
    upstream = new URL(target)
  } catch {
    return proxyError(400, `relay target is not a URL: ${JSON.stringify(target)}`)
  }
  if (upstream.protocol !== 'https:' && upstream.protocol !== 'http:') {
    return proxyError(400, `relay target must be http(s): ${upstream.protocol}`)
  }
  const allowed = (env.DSH_PROXY_ALLOW ?? '').split(',').map(host => host.trim()).filter(host => host !== '')
  if (allowed.length > 0 && !allowed.includes(upstream.host)) {
    return proxyError(403, `relay host is not in DSH_PROXY_ALLOW: ${upstream.host}`)
  }
  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        [PROXY_MARKER]: '1',
        'access-control-allow-origin': '*',
        'access-control-allow-headers': FORWARDED_HEADERS.join(', '),
        'access-control-allow-methods': 'GET, POST, OPTIONS',
        'access-control-max-age': '86400',
      },
    })
  }

  const headers = new Headers()
  for (const name of FORWARDED_HEADERS) {
    const value = request.headers.get(name)
    if (value !== null) headers.set(name, value)
  }
  const bodyless = request.method === 'GET' || request.method === 'HEAD'
  let response: Response
  try {
    response = await fetch(upstream.toString(), {
      method: request.method,
      headers,
      ...bodyless ? {} : { body: request.body },
      redirect: 'follow',
    })
  } catch (reason) {
    return proxyError(502, `relay could not reach ${upstream.origin}: ${(reason as Error).message}`)
  }
  const out = new Headers(response.headers)
  for (const name of DROPPED_HEADERS) out.delete(name)
  out.set(PROXY_MARKER, '1')
  // The upstream body always comes back, including on GET: a model listing is
  // an ordinary GET whose body is the answer. `bodyless` describes the request.
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: out,
  })
}

/**
 * Build a relay refusal the harness surfaces verbatim.
 * @param status - HTTP status to answer with.
 * @param message - what the relay could not do.
 * @returns the JSON refusal.
 */
function proxyError(status: number, message: string): Response {
  return new Response(JSON.stringify({ error: 'relay', message }), {
    status,
    headers: {
      [PROXY_MARKER]: '1',
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  })
}

export default {
  /**
   * Gate every request, then hand the authenticated ones to the asset layer.
   * @param request - the incoming request.
   * @param env - asset binding and the two gate secrets.
   * @returns the login page, a redirect, or the asset response.
   */
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)

    if (url.pathname === LOGOUT_PATH) return handleLogout()
    if (url.pathname === GATE_PATH || url.pathname === `${GATE_PATH}/`) return handleGate(request, url, env)

    const password = env.DSH_SITE_PASSWORD
    const secret = env.DSH_SITE_SECRET
    if (password === undefined || password === '' || secret === undefined || secret === '') {
      // Fail closed: without both values no request can be authorized, and a
      // silent open gate would be the worst possible failure mode.
      return new Response('这个部署还没有设置访问密码：DSH_SITE_PASSWORD / DSH_SITE_SECRET 未配置。', {
        status: 503,
        headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
      })
    }

    if (await hasSession(request, secret)) {
      if (url.pathname.startsWith(PROXY_PATH)) return handleProxy(request, url, env)
      return env.ASSETS.fetch(request)
    }
    if (wantsHtml(request)) return toGate(url)
    return new Response(JSON.stringify({ error: 'unauthorized', gate: GATE_PATH }), {
      status: 401,
      headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
    })
  },
}
