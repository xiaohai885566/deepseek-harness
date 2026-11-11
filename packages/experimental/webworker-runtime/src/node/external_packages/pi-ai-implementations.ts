/**
 * The one registry that lets the real pi-ai stack run in a browser worker.
 *
 * pi-ai reaches its wire implementations through `@earendil-works/pi-ai/api/*.lazy`,
 * its catalog through `/providers/all`, and its collection factories through
 * `/models`; a worker host can resolve none of them from the VFS, because the
 * package is Node-shaped and its `providers/all` face pulls five cloud SDKs. The
 * worker bundle therefore imports the real graph (`./pi-ai-install.ts`) and
 * publishes it here before the host boots, and `./pi-ai.ts` serves this object
 * instead of its refusals.
 *
 * Absence is the documented preview posture and stays loud: a worker booted
 * without an install refuses exactly as it did before. Presence is total — the
 * stub and the registry publish the same members, so a partial install cannot
 * leave one symbol working and another refusing silently.
 * @module @deepseek-ai/dsh-experimental-webworker-runtime/src/node/external_packages/pi-ai-implementations
 */

/** The stream face one wire protocol offers; `api/*.lazy` publishes a factory for it. */
export interface PiAiProviderStreams {
  readonly stream: (...args: never[]) => unknown
  readonly streamSimple: (...args: never[]) => unknown
}

/** A wire implementation factory, the shape `api/*.lazy` exports. */
export type PiAiApiFactory = () => PiAiProviderStreams

/** A catalog provider, as pi-ai's `/providers/all` publishes it. */
export interface PiAiProviderShape {
  readonly id: string
  readonly name: string
  readonly baseUrl?: string
  readonly auth: unknown
  getModels(): readonly { readonly id: string }[]
  readonly stream: (...args: never[]) => unknown
  readonly streamSimple: (...args: never[]) => unknown
}

/** Everything the worker bundle supplies for the three wired protocols and the collection factories. */
export interface PiAiImplementations {
  /** `openai-completions` protocol over the OpenAI SDK. */
  readonly openAICompletionsApi: PiAiApiFactory
  /** `openai-responses` protocol over the OpenAI SDK. */
  readonly openAIResponsesApi: PiAiApiFactory
  /** `anthropic-messages` protocol over the Anthropic SDK. */
  readonly anthropicMessagesApi: PiAiApiFactory
  /** Empty `Models` collection factory, `pi-ai/models`' own. */
  readonly createModels: (...args: never[]) => unknown
  /** Static single-protocol provider factory, `pi-ai/models`' own. */
  readonly createProvider: (...args: never[]) => unknown
  /** Reasoning-level resolver, `pi-ai/models`' own. */
  readonly getSupportedThinkingLevels: (...args: never[]) => unknown
  /** Context-overflow predicate, `pi-ai/utils/overflow`' own. */
  readonly isContextOverflow: (...args: never[]) => unknown
  /** Every catalog provider this deployment serves, each carrying its models. */
  readonly builtinProviders: () => readonly PiAiProviderShape[]
}

let installed: PiAiImplementations | undefined

/**
 * Publish the real implementations to this worker.
 *
 * Called by the worker bundle before the host receives its `init` frame: the tree
 * builds providers while `llm-pi-ai` activates, which is before any request, so a
 * later install would arrive after the first route had already been refused.
 * @param implementations - the three protocols, the collection factories, and the catalog reader.
 */
export function installPiAiImplementations(implementations: PiAiImplementations): void {
  installed = implementations
}

/**
 * What the pi-ai module face should answer.
 * @returns the installed implementations, or undefined when this worker has none.
 */
export function piAiImplementations(): PiAiImplementations | undefined {
  return installed
}
