#!/usr/bin/env node
/**
 * Cloudflare Containers edge proxy for DeepSeek Harness.
 *
 * The platform reaches this process on `DSH_EDGE_PORT`; the harness listener
 * sits behind it on loopback. The proxy owns three things:
 *
 * 1. Request authority. `dsh web` refuses any `Host` that is not loopback, its
 *    own bind address, or an explicit `--trusted-host` entry, and refuses an
 *    attached `Origin` that disagrees with `Host`. The container's external
 *    name is not known when the listener starts, so every forwarded request
 *    carries the loopback authority and `Origin` follows it. `--public-url`
 *    still advertises the browser-facing root, which grants no trust.
 * 2. Readiness. The listener prints its tokenized launch URL once the plugin
 *    tree settles; `/health` answers 200 only after that line, so the Durable
 *    Object never forwards traffic into a half-mounted host.
 * 3. Session handoff. The launch URL is a process credential. It is never
 *    echoed in a body; an unauthenticated index request is redirected to
 *    `/?token=...` so the listener mints the signed cookie, and `/__dsh/launch`
 *    re-issues the same redirect on demand.
 *
 * Every failure path answers with a status and a short line rather than
 * throwing, because a supervisor reads this process's exit code.
 */

import http from 'node:http'
import net from 'node:net'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

/** Interface the platform connects to. */
const LISTEN_HOST = process.env.DSH_EDGE_HOST ?? '0.0.0.0'
/** Port the platform routes to. */
const LISTEN_PORT = Number(process.env.DSH_EDGE_PORT ?? 8080)
/** Loopback host the harness listener binds. */
const UPSTREAM_HOST = '127.0.0.1'
/** Loopback port the harness listener binds. */
const UPSTREAM_PORT = Number(process.env.DSH_UPSTREAM_PORT ?? 3080)
/** Authority every forwarded request claims; loopback is always trusted. */
const UPSTREAM_AUTHORITY = `${UPSTREAM_HOST}:${UPSTREAM_PORT}`
/** Browser-facing root advertised by `--public-url`; empty when unknown. */
const PUBLIC_URL = (process.env.DSH_PUBLIC_URL ?? '').replace(/\/+$/, '')
/** Optional shared key guarding the `/__dsh/*` control endpoints. */
const EDGE_KEY = process.env.DSH_EDGE_KEY ?? ''
/** Working directory the agent operates in. */
const WORKSPACE = process.env.DSH_WORKSPACE ?? '/workspace'
/** Repository root inside the image. */
const APP_ROOT = process.env.DSH_APP_ROOT ?? '/app'
/** Headers that describe one hop and must not be replayed. */
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
])

/** Token from the listener's launch URL, once printed. */
let launchToken
/** Whether the listener announced readiness. */
let ready = false
/** Child process running the harness. */
let child
/** Set while the process is shutting down so an expected exit is not fatal. */
let stopping = false

/**
 * Write one line to the container log, which the platform collects.
 * @param message - text to record.
 */
function log(message) {
  console.log(`[edge] ${message}`)
}

/**
 * Resolve the command that boots the web profile: the built bin when the image
 * build produced it, the TypeScript entry through tsx otherwise.
 * @returns executable and arguments for the harness process.
 */
function harnessCommand() {
  const built = `${APP_ROOT}/apps/cli/lib/bin.js`
  const source = `${APP_ROOT}/apps/cli/src/bin.ts`
  const flags = [
    'web',
    '--no-open',
    '--host',
    UPSTREAM_HOST,
    '--port',
    String(UPSTREAM_PORT),
    ...PUBLIC_URL ? ['--public-url', `${PUBLIC_URL}/`] : [],
  ]
  if (existsSync(built)) return { command: process.execPath, args: [built, ...flags] }
  // The source entry needs the loader, and the loader resolves from the image,
  // not from the workspace the process runs in.
  const require = createRequire(`${APP_ROOT}/package.json`)
  const loader = pathToFileURL(require.resolve('tsx/esm')).href
  return { command: process.execPath, args: ['--import', loader, source, ...flags] }
}

/**
 * Scan one listener output line for the launch URL and keep its token.
 * @param line - one complete stdout line.
 */
function inspectLine(line) {
  const match = /dsh web:\s*(\S+)/.exec(line)
  if (match === null) return
  try {
    const url = new URL(match[1])
    const token = url.searchParams.get('token')
    if (token === null || token === '') return
    launchToken = token
    ready = true
    log(`listener ready; launch URL captured (${url.origin}${url.pathname})`)
  } catch {
    // A line that does not parse as a URL is not the readiness signal.
  }
}

/**
 * Pipe one child stream to this process's own stream, inspecting stdout.
 * @param stream - child stream to consume.
 * @param output - stream to write through.
 */
function pump(stream, output) {
  let pending = ''
  stream.setEncoding('utf8')
  stream.on('data', (chunk) => {
    output.write(chunk)
    pending += chunk
    let index = pending.indexOf('\n')
    while (index >= 0) {
      inspectLine(pending.slice(0, index))
      pending = pending.slice(index + 1)
      index = pending.indexOf('\n')
    }
  })
}

/**
 * Start the harness listener and keep its output on this process's log.
 */
function startHarness() {
  const { command, args } = harnessCommand()
  log(`starting ${command} ${args.join(' ')}`)
  child = spawn(command, args, {
    cwd: WORKSPACE,
    env: { ...process.env, DSH_HOME: process.env.DSH_HOME ?? '/data/home' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  pump(child.stdout, process.stdout)
  pump(child.stderr, process.stderr)
  child.on('exit', (code, signal) => {
    if (stopping) return
    log(`listener exited (code=${String(code)} signal=${String(signal)}); stopping the container`)
    process.exit(1)
  })
  child.on('error', (error) => {
    log(`listener failed to spawn: ${error.message}`)
    process.exit(1)
  })
}

/**
 * Whether the request addresses the index document, which is the only path
 * that exchanges the launch token for a session cookie.
 * @param url - request target.
 * @returns true for `/` and `/index.html` without a token parameter.
 */
function isIndexRequest(url) {
  const parsed = new URL(url, `http://${UPSTREAM_AUTHORITY}`)
  if (parsed.searchParams.has('token')) return false
  return parsed.pathname === '/' || parsed.pathname === '/index.html'
}

/**
 * Answer a `/__dsh/*` control request locally.
 * @param request - incoming request.
 * @param response - response to write.
 * @returns true when the request was answered here.
 */
function control(request, response) {
  const url = new URL(request.url ?? '/', `http://${UPSTREAM_AUTHORITY}`)
  if (!url.pathname.startsWith('/__dsh/') && url.pathname !== '/health') return false
  if (url.pathname === '/health') {
    response.writeHead(ready ? 200 : 503, { 'content-type': 'application/json', 'cache-control': 'no-store' })
    response.end(JSON.stringify({ ready, upstream: UPSTREAM_AUTHORITY }))
    return true
  }
  if (EDGE_KEY !== '' && url.searchParams.get('key') !== EDGE_KEY) {
    response.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' })
    response.end('forbidden\n')
    return true
  }
  if (url.pathname === '/__dsh/launch') {
    if (launchToken === undefined) {
      response.writeHead(503, { 'content-type': 'text/plain; charset=utf-8', 'retry-after': '5' })
      response.end('the harness listener has not announced its launch URL yet\n')
      return true
    }
    response.writeHead(302, { location: `/?token=${encodeURIComponent(launchToken)}`, 'cache-control': 'no-store' })
    response.end()
    return true
  }
  if (url.pathname === '/__dsh/status') {
    response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
    response.end(JSON.stringify({
      ready,
      publicUrl: PUBLIC_URL === '' ? null : PUBLIC_URL,
      upstream: UPSTREAM_AUTHORITY,
      workspace: WORKSPACE,
      pid: child?.pid ?? null,
    }))
    return true
  }
  response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
  response.end('unknown control endpoint\n')
  return true
}

/**
 * Build the header set forwarded upstream: loopback authority, matching Origin,
 * no hop-by-hop fields.
 * @param headers - incoming request headers.
 * @returns headers to send to the listener.
 */
function upstreamHeaders(headers) {
  const forwarded = {}
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined || HOP_BY_HOP.has(name)) continue
    forwarded[name] = value
  }
  forwarded.host = UPSTREAM_AUTHORITY
  if (typeof headers.origin === 'string') forwarded.origin = `http://${UPSTREAM_AUTHORITY}`
  return forwarded
}

/**
 * Answer with a one-line diagnostic.
 * @param response - response to write.
 * @param status - HTTP status.
 * @param message - body text.
 */
function fail(response, status, message) {
  if (response.headersSent) {
    response.destroy()
    return
  }
  response.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
  response.end(`${message}\n`)
}

/**
 * Proxy one ordinary HTTP request to the listener.
 * @param request - incoming request.
 * @param response - response to write.
 */
function forward(request, response) {
  const upstream = http.request({
    host: UPSTREAM_HOST,
    port: UPSTREAM_PORT,
    method: request.method,
    path: request.url,
    headers: upstreamHeaders(request.headers),
  }, (upstreamResponse) => {
    // An unauthenticated index is the one answer worth replacing: the browser
    // has no cookie yet, and the launch token is the only way to mint one.
    if (upstreamResponse.statusCode === 401 && launchToken !== undefined && isIndexRequest(request.url ?? '/')) {
      upstreamResponse.resume()
      response.writeHead(302, { location: `/?token=${encodeURIComponent(launchToken)}`, 'cache-control': 'no-store' })
      response.end()
      return
    }
    const headers = {}
    for (const [name, value] of Object.entries(upstreamResponse.headers)) {
      if (value === undefined || HOP_BY_HOP.has(name)) continue
      headers[name] = value
    }
    response.writeHead(upstreamResponse.statusCode ?? 502, headers)
    upstreamResponse.pipe(response)
    upstreamResponse.on('error', () => response.destroy())
  })
  upstream.setTimeout(0)
  upstream.on('error', (error) => {
    fail(response, 502, `harness listener unreachable: ${error.message}`)
  })
  request.pipe(upstream)
  request.on('aborted', () => upstream.destroy())
}

/**
 * Rebuild a request head for a raw socket, with the same authority rewrite the
 * HTTP path applies. WebSocket upgrades carry their own handshake and cannot be
 * replayed through `http.request`.
 * @param request - the upgrade request.
 * @returns bytes to write to the listener socket.
 */
function serializeUpgradeHead(request) {
  const headers = upstreamHeaders(request.headers)
  headers.connection = 'Upgrade'
  headers.upgrade = request.headers.upgrade ?? 'websocket'
  const lines = [`${request.method ?? 'GET'} ${request.url ?? '/'} HTTP/1.1`]
  for (const [name, value] of Object.entries(headers)) {
    if (Array.isArray(value)) for (const item of value) lines.push(`${name}: ${item}`)
    else lines.push(`${name}: ${value}`)
  }
  return `${lines.join('\r\n')}\r\n\r\n`
}

/**
 * Proxy one WebSocket upgrade to the listener by piping both sockets.
 * @param request - the upgrade request.
 * @param socket - the client socket.
 * @param head - bytes already read past the request head.
 */
function forwardUpgrade(request, socket, head) {
  socket.setNoDelay(true)
  socket.setTimeout(0)
  const upstream = net.connect(UPSTREAM_PORT, UPSTREAM_HOST, () => {
    upstream.setNoDelay(true)
    upstream.setTimeout(0)
    upstream.write(serializeUpgradeHead(request))
    if (head.length > 0) upstream.write(head)
    upstream.pipe(socket)
    socket.pipe(upstream)
  })
  upstream.on('error', () => socket.destroy())
  socket.on('error', () => upstream.destroy())
  upstream.on('close', () => socket.destroy())
  socket.on('close', () => upstream.destroy())
}

const server = http.createServer((request, response) => {
  request.socket.setTimeout(0)
  if (control(request, response)) return
  forward(request, response)
})

server.on('upgrade', (request, socket, head) => {
  if ((request.url ?? '/').startsWith('/__dsh/')) {
    socket.destroy()
    return
  }
  forwardUpgrade(request, socket, head)
})

server.on('clientError', (_error, socket) => socket.destroy())

server.listen(LISTEN_PORT, LISTEN_HOST, () => {
  log(`edge proxy on ${LISTEN_HOST}:${LISTEN_PORT} -> ${UPSTREAM_AUTHORITY}`)
  startHarness()
})

/**
 * Stop the listener, then this process, within the platform's grace period.
 * @param signal - signal that requested the stop.
 */
function shutdown(signal) {
  if (stopping) return
  stopping = true
  log(`received ${signal}; stopping`)
  server.close()
  child?.kill('SIGTERM')
  setTimeout(() => process.exit(0), 3000).unref()
  child?.once('exit', () => process.exit(0))
}

process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))
