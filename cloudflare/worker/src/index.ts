import { DurableObject } from 'cloudflare:workers'

/**
 * Cloudflare Worker in front of the DeepSeek Harness container.
 *
 * The harness is a Node program: its web profile owns a `node:http` listener,
 * spawns shell tools, and loads a native addon. None of that runs in a Worker
 * isolate, so the deployment unit is a Container and this Worker is the router
 * that starts it, waits for readiness, and forwards HTTP and WebSocket traffic.
 *
 * Every request lands in one Durable Object, because the harness is a single
 * stateful host: sessions, the workspace, and the browser cookie secret live on
 * that instance's disk. Routing two requests to two instances would split one
 * conversation across two filesystems.
 */

/** Port the container's edge proxy listens on; the image exposes the same one. */
const EDGE_PORT = 8080

/** Container sizes the platform offers; anything else falls back to the default. */
const INSTANCE_SIZES = ['lite', 'basic', 'standard-1', 'standard-2', 'standard-3', 'standard-4'] as const

/** One accepted container size. */
type InstanceSize = (typeof INSTANCE_SIZES)[number]

/** Readiness attempts before a request gives up: 600 × 250ms = 150s. */
const READY_ATTEMPTS = 600

/** Delay between readiness probes. */
const READY_INTERVAL_MS = 250

/** Bindings this Worker reads. Secrets are set with `wrangler secret put`. */
export interface Env {
  /** Namespace holding the single harness instance. */
  DSH: DurableObjectNamespace<DshContainer>
  /** Model credential forwarded to the container. */
  DEEPSEEK_API_KEY?: string
  /** Browser-facing root advertised to the harness; derived from the request when unset. */
  DSH_PUBLIC_URL?: string
  /** `user:password` gate in front of the whole deployment; unset disables it. */
  DSH_BASIC_AUTH?: string
  /** Container instance size: lite, standard-1 … standard-4. */
  DSH_INSTANCE?: string
  /** Idle milliseconds before the container stops. */
  DSH_IDLE_TIMEOUT_MS?: string
  /** Shared key guarding the container's `/__dsh/*` control endpoints. */
  DSH_EDGE_KEY?: string
  /** Extra container environment as a JSON object of strings. */
  DSH_EXTRA_ENV?: string
}

/**
 * Compare two strings without leaking their common prefix length through timing.
 * @param left - first value.
 * @param right - second value.
 * @returns true when both are equal.
 */
function timingSafeEqual(left: string, right: string): boolean {
  const length = Math.max(left.length, right.length)
  let difference = left.length ^ right.length
  for (let index = 0; index < length; index += 1) {
    difference |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0)
  }
  return difference === 0
}

/**
 * Answer the optional HTTP Basic gate configured by `DSH_BASIC_AUTH`.
 * Cloudflare Access is the better gate when the deployment has a zone; this one
 * exists so a bare `workers.dev` deployment is not world-writable.
 * @param request - incoming request.
 * @param env - Worker bindings.
 * @returns a challenge response, or undefined when the request may proceed.
 */
function basicAuthGate(request: Request, env: Env): Response | undefined {
  const configured = env.DSH_BASIC_AUTH
  if (configured === undefined || configured === '') return undefined
  const header = request.headers.get('authorization')
  const challenge = {
    'www-authenticate': 'Basic realm="DeepSeek Harness", charset="UTF-8"',
    'content-type': 'text/plain; charset=utf-8',
    'cache-control': 'no-store',
  }
  if (header === null || !header.toLowerCase().startsWith('basic ')) {
    return new Response('authentication required\n', { status: 401, headers: challenge })
  }
  let decoded = ''
  try {
    decoded = atob(header.slice(6).trim())
  } catch {
    return new Response('malformed credentials\n', { status: 400, headers: challenge })
  }
  return timingSafeEqual(decoded, configured)
    ? undefined
    : new Response('authentication required\n', { status: 401, headers: challenge })
}

/**
 * One harness host: starts the container on first use, keeps it warm while the
 * deployment is in use, and forwards every request to its edge proxy.
 */
export class DshContainer extends DurableObject<Env> {
  /** Startup shared by concurrent requests, cleared once it settles. */
  private starting: Promise<void> | undefined

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    // A restart can reach an already running container; re-apply the idle
    // timeout so the previous configuration does not outlive the deployment.
    if (ctx.container?.running === true) {
      void ctx.blockConcurrencyWhile(() => this.tune())
    }
  }

  /**
   * Forward one request, starting the container first when needed.
   * @param request - incoming request, including WebSocket upgrades.
   * @returns the edge proxy's response, returned unmodified so an upgrade survives.
   */
  override async fetch(request: Request): Promise<Response> {
    this.starting ??= this.ensureRunning(request).finally(() => {
      this.starting = undefined
    })
    await this.starting
    const container = this.ctx.container
    if (container === undefined) throw new Error('dsh: no container is configured for this Durable Object')
    // The platform routes to the container by port; the request keeps its path,
    // query, method, and body, and the edge proxy rewrites the authority.
    const target = new URL(request.url)
    target.protocol = 'http:'
    target.host = 'container'
    const forwarded = new Request(target, request)
    forwarded.headers.delete('host')
    return container.getTcpPort(EDGE_PORT).fetch(forwarded)
  }

  /**
   * Report the container's own view of readiness for operators and alarms.
   * @returns a JSON snapshot of the instance.
   */
  async status(): Promise<unknown> {
    const container = this.ctx.container
    if (container === undefined) return { running: false }
    return { running: container.running, info: await container.inspect() }
  }

  /**
   * Start the container when it is not running.
   * @param request - the request that triggered startup, whose origin becomes the advertised root.
   */
  private async ensureRunning(request: Request): Promise<void> {
    const container = this.ctx.container
    if (container === undefined) throw new Error('dsh: no container is configured for this Durable Object')
    if (!container.running) {
      container.start({
        image: container.images.base,
        instance: this.instanceType(),
        // The harness calls the model provider and any MCP server the user adds.
        enableInternet: true,
        env: this.containerEnv(request),
      })
    }
    await this.tune()
    await this.waitForReady()
  }

  /**
   * Apply the idle timeout that decides when the platform stops the container.
   */
  private async tune(): Promise<void> {
    const container = this.ctx.container
    if (container === undefined) return
    await container.setInactivityTimeout(this.idleTimeoutMs())
  }

  /**
   * Poll the edge proxy until the harness listener has announced itself.
   * @throws when the listener never becomes ready.
   */
  private async waitForReady(): Promise<void> {
    const container = this.ctx.container
    if (container === undefined) throw new Error('dsh: no container is configured for this Durable Object')
    const port = container.getTcpPort(EDGE_PORT)
    let lastError: unknown
    for (let attempt = 0; attempt < READY_ATTEMPTS; attempt += 1) {
      try {
        const response = await port.fetch(`http://container/health`, { signal: AbortSignal.timeout(2000) })
        await response.body?.cancel()
        if (response.ok) return
        lastError = new Error(`edge proxy reported ${response.status}`)
      } catch (error) {
        lastError = error
      }
      await scheduler.wait(READY_INTERVAL_MS)
    }
    throw new Error(`dsh: the harness did not become ready on port ${EDGE_PORT}`, { cause: lastError })
  }

  /**
   * Instance size for `start()`. The image carries a full pnpm workspace, so
   * standard-1's 8 GB disk is the floor and standard-2 is the default.
   * @returns the configured size, or standard-2 when unset or unrecognized.
   */
  private instanceType(): InstanceSize {
    const configured = this.env.DSH_INSTANCE ?? ''
    return (INSTANCE_SIZES as readonly string[]).includes(configured)
      ? configured as InstanceSize
      : 'standard-2'
  }

  /**
   * Idle timeout for the container.
   * @returns the configured milliseconds, defaulting to two hours.
   */
  private idleTimeoutMs(): number {
    const configured = Number(this.env.DSH_IDLE_TIMEOUT_MS ?? '')
    return Number.isFinite(configured) && configured >= 60_000 ? configured : 2 * 60 * 60 * 1000
  }

  /**
   * Environment handed to the container process at startup.
   * @param request - the request that triggered startup.
   * @returns variable name to value, all strings.
   */
  private containerEnv(request: Request): Record<string, string> {
    const origin = new URL(request.url).origin
    const env: Record<string, string> = {
      DSH_PUBLIC_URL: this.env.DSH_PUBLIC_URL ?? `${origin}/`,
      DSH_EDGE_PORT: String(EDGE_PORT),
      DSH_UPSTREAM_PORT: '3080',
      DSH_HOME: '/data/home',
      DSH_WORKSPACE: '/workspace',
      DSH_APP_ROOT: '/app',
    }
    if (this.env.DEEPSEEK_API_KEY !== undefined && this.env.DEEPSEEK_API_KEY !== '') {
      env.DEEPSEEK_API_KEY = this.env.DEEPSEEK_API_KEY
    }
    if (this.env.DSH_EDGE_KEY !== undefined && this.env.DSH_EDGE_KEY !== '') {
      env.DSH_EDGE_KEY = this.env.DSH_EDGE_KEY
    }
    if (this.env.DSH_EXTRA_ENV !== undefined && this.env.DSH_EXTRA_ENV !== '') {
      try {
        const extra: unknown = JSON.parse(this.env.DSH_EXTRA_ENV)
        if (extra !== null && typeof extra === 'object') {
          for (const [name, value] of Object.entries(extra as Record<string, unknown>)) {
            if (typeof value === 'string') env[name] = value
          }
        }
      } catch {
        // A malformed override is ignored rather than failing every request.
      }
    }
    return env
  }
}

export default {
  /**
   * Route every request into the single harness instance.
   * @param request - incoming request.
   * @param env - Worker bindings.
   * @returns the container's response.
   */
  async fetch(request: Request, env: Env): Promise<Response> {
    const unauthorized = basicAuthGate(request, env)
    if (unauthorized !== undefined) return unauthorized
    return env.DSH.getByName('main').fetch(request)
  },
} satisfies ExportedHandler<Env>
