/**
 * `@earendil-works/pi-ai` stub, including its `/providers/all`, `/api/*.lazy`,
 * `/models`, and `/utils/overflow` subpaths. The package is Node-only in its
 * aggregate faces (its `providers/all` pulls five cloud SDKs and one API
 * implementation imports `node:`) and `llm-pi-ai` imports it statically at module
 * scope, so the row cannot mount without this module.
 *
 * Two postures, one face:
 *   - **Installed.** The worker bundle imported the real graph and published it
 *     through {@link installPiAiImplementations} before the host booted. Every
 *     member below then delegates to the real implementation, so a configured
 *     route reaches the network and a built-in provider lists its models.
 *   - **Absent.** Nothing was installed. `builtinProviders()` reports providers
 *     with no models and every call path lands on a loud refusal naming the
 *     unavailable symbol. That is the posture of a worker booted from a bundle
 *     that carries no implementation, and it stays loud rather than degrading
 *     into a silently empty catalog.
 *
 * Delegation is per call, not per module evaluation: this module is evaluated
 * while the static table is built, which is before `installPiAi()` runs, so a
 * bound reference here would capture the refusal and never see the install.
 *
 * Every symbol `llm-pi-ai` imports by name is present in both postures: a
 * missing CommonJS symbol would surface as `undefined` at call time instead of a
 * link error.
 */
import { notImplementedFail } from '../notImplementedFail.ts'
import {
  installPiAiImplementations, piAiImplementations,
  type PiAiApiFactory, type PiAiProviderShape,
} from './pi-ai-implementations.ts'

export { installPiAiImplementations, piAiImplementations }
export type {
  PiAiApiFactory, PiAiImplementations, PiAiProviderShape, PiAiProviderStreams,
} from './pi-ai-implementations.ts'

const MODULE = '@earendil-works/pi-ai'

/** The callable members this module serves, each resolvable at call time. */
type Delegated =
  | 'createProvider' | 'createModels' | 'getSupportedThinkingLevels' | 'isContextOverflow'
  | 'openAICompletionsApi' | 'openAIResponsesApi' | 'anthropicMessagesApi'

/**
 * Build a member that answers the installed implementation, or refuses naming
 * itself when this worker has none.
 * @param symbol - the member being served.
 * @returns a function forwarding its arguments to the installed implementation.
 */
function delegate<Face extends (...args: never[]) => unknown>(symbol: Delegated): Face {
  return ((...args: never[]) => {
    const installed = piAiImplementations()
    if (installed === undefined) return notImplementedFail<(...inner: never[]) => never>(MODULE, symbol)(...args)
    return (installed[symbol] as (...inner: never[]) => unknown)(...args)
  }) as Face
}

/** Provider factory: pi-ai's own when installed, otherwise a refusal. */
export const createProvider = delegate<(input: never) => unknown>('createProvider')

/** Empty `Models` collection factory: pi-ai's own when installed, otherwise a refusal. */
export const createModels = delegate<(options?: never) => unknown>('createModels')

/** Reasoning-level resolver: pi-ai's own when installed, otherwise a refusal. */
export const getSupportedThinkingLevels = delegate<(model: never) => unknown>('getSupportedThinkingLevels')

/** Context-overflow predicate: pi-ai's own when installed, otherwise a refusal. */
export const isContextOverflow = delegate<(message: never, contextWindow: never) => unknown>('isContextOverflow')

/** `openai-completions` protocol factory: the real one when installed, otherwise a refusal. */
export const openAICompletionsApi = delegate<PiAiApiFactory>('openAICompletionsApi')

/** `openai-responses` protocol factory: the real one when installed, otherwise a refusal. */
export const openAIResponsesApi = delegate<PiAiApiFactory>('openAIResponsesApi')

/** `anthropic-messages` protocol factory: the real one when installed, otherwise a refusal. */
export const anthropicMessagesApi = delegate<PiAiApiFactory>('anthropicMessagesApi')

/**
 * Preview provider ids, in catalog order. Used only in the absent posture, where
 * the adapter still needs pi-ai's own identifiers to attach authentication
 * metadata to: an empty list would make `llm-pi-ai` register no provider at all.
 */
const BUILTIN_PROVIDER_IDS: readonly string[] = [
  'ant-ling', 'anthropic', 'azure', 'baseten', 'cerebras', 'cloudflare-ai-gateway',
  'cloudflare-workers-ai', 'deepseek', 'fireworks', 'github-copilot', 'groq', 'huggingface',
  'kimi-coding', 'meta', 'minimax', 'minimax-cn', 'moonshotai', 'moonshotai-cn', 'nvidia',
  'openai', 'opencode', 'opencode-go', 'openrouter', 'qwen-token-plan', 'qwen-token-plan-cn',
  'qwen-token-plan-individual', 'radius', 'together', 'typesafe', 'vercel-ai-gateway', 'xai',
  'xiaomi', 'xiaomi-token-plan-ams', 'xiaomi-token-plan-cn', 'xiaomi-token-plan-sgp',
  'zai', 'zai-coding-cn',
]

/**
 * Catalog providers, read while `llm-pi-ai` activates.
 * @returns the installed catalog with each provider's models, or model-less
 *   placeholders naming pi-ai's providers when this worker has no implementation.
 */
export function builtinProviders(): PiAiProviderShape[] {
  const installed = piAiImplementations()
  if (installed !== undefined) return [...installed.builtinProviders()]
  return BUILTIN_PROVIDER_IDS.map(id => ({
    id,
    name: id,
    auth: { apiKey: { type: 'api-key' } },
    getModels: () => [],
    stream: notImplementedFail(MODULE, 'stream'),
    streamSimple: notImplementedFail(MODULE, 'streamSimple'),
  }))
}

/**
 * Models of one installed catalog provider.
 * @param id - provider id the route names.
 * @returns the provider's models, or none when this worker has no implementation.
 */
export function getBuiltinModels(id?: string): unknown[] {
  const installed = piAiImplementations()
  if (installed === undefined) return []
  const provider = installed.builtinProviders().find(entry => entry.id === id)
  return provider === undefined ? [] : [...provider.getModels()]
}

/**
 * Models of every type of one installed catalog provider.
 * @param id - provider id the route names.
 * @returns the same catalog: a browser deployment exposes one model list per provider.
 */
export function getAllBuiltinModels(id?: string): unknown[] {
  return getBuiltinModels(id)
}

/**
 * A `Models` collection with every served provider registered.
 * @param options - credential storage and ambient authentication integrations.
 * @returns the collection, or a refusal when this worker has no implementation.
 */
export function builtinModels(options?: unknown): unknown {
  const installed = piAiImplementations()
  if (installed === undefined) return notImplementedFail<(options?: unknown) => never>(MODULE, 'builtinModels')(options)
  const models = installed.createModels(options as never) as { setProvider(provider: unknown): void }
  for (const provider of installed.builtinProviders()) models.setProvider(provider)
  return models
}

/** CommonJS interop marker: the worker loader hands `default` to default imports. */
export const __esModule = true

/** CommonJS default export: the members `require()` hands a caller of this module. */
export default {
  createProvider, createModels, getSupportedThinkingLevels, isContextOverflow, builtinModels, builtinProviders,
  getBuiltinModels, getAllBuiltinModels, anthropicMessagesApi, openAICompletionsApi, openAIResponsesApi,
  installPiAiImplementations, piAiImplementations,
}
