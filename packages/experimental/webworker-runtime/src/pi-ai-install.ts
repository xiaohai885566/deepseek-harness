/**
 * The page's install of the real pi-ai stack into a worker host.
 *
 * `./node/external_packages/pi-ai.ts` stands in for `@earendil-works/pi-ai` in
 * the VFS, because the package cannot be mounted there: its `providers/all`
 * face pulls five cloud SDKs and one of its API implementations imports
 * `node:`. The worker bundle *can* carry it, though — the three wired protocols
 * transport over `openai` and `@anthropic-ai/sdk`, both of which ship a
 * browser ESM build with no Node builtin at module scope, and pi-ai itself
 * passes `dangerouslyAllowBrowser` plus the Anthropic direct-browser header.
 *
 * So this module imports the real graph, assembles the catalog from the
 * provider factories whose protocols this deployment serves, and publishes the
 * result through {@link installPiAiImplementations}. The stub then answers the
 * VFS-loaded `llm-pi-ai` with working implementations.
 *
 * Deliberately absent, and why each one is a separate protocol rather than an
 * oversight: `amazon-bedrock` (@aws-sdk), `google` and `google-vertex`
 * (@google/genai), `mistral` (@mistralai), and `openai-codex` (imports
 * `node:`). A route naming one of their protocols still fails loudly through
 * `llm-pi-ai`'s own unsupported-protocol check.
 *
 * Cost note: every import here is data plus a lazy wrapper — `api/*.lazy.js`
 * defers its implementation behind `import()`, so the OpenAI and Anthropic SDK
 * chunks load on the first model request, not at worker boot.
 * @module @deepseek-ai/dsh-experimental-webworker-runtime/src/pi-ai-install
 */
import { anthropicMessagesApi } from '@earendil-works/pi-ai/api/anthropic-messages.lazy'
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy'
import { openAIResponsesApi } from '@earendil-works/pi-ai/api/openai-responses.lazy'
import { createModels, createProvider, getSupportedThinkingLevels } from '@earendil-works/pi-ai/models'
import { antLingProvider } from '@earendil-works/pi-ai/providers/ant-ling'
import { anthropicProvider } from '@earendil-works/pi-ai/providers/anthropic'
import { azureProvider } from '@earendil-works/pi-ai/providers/azure'
import { basetenProvider } from '@earendil-works/pi-ai/providers/baseten'
import { cerebrasProvider } from '@earendil-works/pi-ai/providers/cerebras'
import { cloudflareAIGatewayProvider } from '@earendil-works/pi-ai/providers/cloudflare-ai-gateway'
import { cloudflareWorkersAIProvider } from '@earendil-works/pi-ai/providers/cloudflare-workers-ai'
import { deepseekProvider } from '@earendil-works/pi-ai/providers/deepseek'
import { fireworksProvider } from '@earendil-works/pi-ai/providers/fireworks'
import { githubCopilotProvider } from '@earendil-works/pi-ai/providers/github-copilot'
import { groqProvider } from '@earendil-works/pi-ai/providers/groq'
import { huggingfaceProvider } from '@earendil-works/pi-ai/providers/huggingface'
import { kimiCodingProvider } from '@earendil-works/pi-ai/providers/kimi-coding'
import { metaProvider } from '@earendil-works/pi-ai/providers/meta'
import { minimaxCnProvider } from '@earendil-works/pi-ai/providers/minimax-cn'
import { minimaxProvider } from '@earendil-works/pi-ai/providers/minimax'
import { moonshotaiCnProvider } from '@earendil-works/pi-ai/providers/moonshotai-cn'
import { moonshotaiProvider } from '@earendil-works/pi-ai/providers/moonshotai'
import { nvidiaProvider } from '@earendil-works/pi-ai/providers/nvidia'
import { openaiProvider } from '@earendil-works/pi-ai/providers/openai'
import { opencodeGoProvider } from '@earendil-works/pi-ai/providers/opencode-go'
import { opencodeProvider } from '@earendil-works/pi-ai/providers/opencode'
import { openrouterProvider } from '@earendil-works/pi-ai/providers/openrouter'
import { qwenTokenPlanCnProvider } from '@earendil-works/pi-ai/providers/qwen-token-plan-cn'
import { qwenTokenPlanIndividualProvider } from '@earendil-works/pi-ai/providers/qwen-token-plan-individual'
import { qwenTokenPlanProvider } from '@earendil-works/pi-ai/providers/qwen-token-plan'
import { radiusProvider } from '@earendil-works/pi-ai/providers/radius'
import { togetherProvider } from '@earendil-works/pi-ai/providers/together'
import { typesafeProvider } from '@earendil-works/pi-ai/providers/typesafe'
import { vercelAIGatewayProvider } from '@earendil-works/pi-ai/providers/vercel-ai-gateway'
import { xaiProvider } from '@earendil-works/pi-ai/providers/xai'
import { xiaomiTokenPlanAmsProvider } from '@earendil-works/pi-ai/providers/xiaomi-token-plan-ams'
import { xiaomiTokenPlanCnProvider } from '@earendil-works/pi-ai/providers/xiaomi-token-plan-cn'
import { xiaomiTokenPlanSgpProvider } from '@earendil-works/pi-ai/providers/xiaomi-token-plan-sgp'
import { xiaomiProvider } from '@earendil-works/pi-ai/providers/xiaomi'
import { zaiCodingCnProvider } from '@earendil-works/pi-ai/providers/zai-coding-cn'
import { zaiProvider } from '@earendil-works/pi-ai/providers/zai'
import { isContextOverflow } from '@earendil-works/pi-ai/utils/overflow'
import type { Provider } from '@earendil-works/pi-ai'
import { installPiAiImplementations } from './node/external_packages/pi-ai-implementations.ts'

/**
 * Catalog providers this deployment serves, in pi-ai's own order. Each is a
 * factory so the list costs nothing until the catalog is first read.
 */
const PROVIDER_FACTORIES: readonly (() => Provider)[] = [
  antLingProvider,
  anthropicProvider,
  azureProvider,
  basetenProvider,
  cerebrasProvider,
  cloudflareAIGatewayProvider,
  cloudflareWorkersAIProvider,
  deepseekProvider,
  fireworksProvider,
  githubCopilotProvider,
  groqProvider,
  huggingfaceProvider,
  kimiCodingProvider,
  metaProvider,
  minimaxProvider,
  minimaxCnProvider,
  moonshotaiProvider,
  moonshotaiCnProvider,
  nvidiaProvider,
  openaiProvider,
  opencodeProvider,
  opencodeGoProvider,
  openrouterProvider,
  qwenTokenPlanProvider,
  qwenTokenPlanCnProvider,
  qwenTokenPlanIndividualProvider,
  radiusProvider,
  togetherProvider,
  typesafeProvider,
  vercelAIGatewayProvider,
  xaiProvider,
  xiaomiProvider,
  xiaomiTokenPlanAmsProvider,
  xiaomiTokenPlanCnProvider,
  xiaomiTokenPlanSgpProvider,
  zaiProvider,
  zaiCodingCnProvider,
]

/**
 * Publish the real pi-ai stack to this worker's module table.
 *
 * Runs at worker-bundle evaluation, before the host mounts the image: `llm-pi-ai`
 * reads the catalog while it activates and builds each route's provider then, so
 * an install after boot would leave the first route refused.
 */
export function installPiAi(): void {
  installPiAiImplementations({
    anthropicMessagesApi,
    openAICompletionsApi,
    openAIResponsesApi,
    createModels,
    createProvider,
    getSupportedThinkingLevels,
    isContextOverflow,
    builtinProviders: () => PROVIDER_FACTORIES.map(factory => factory()),
  })
}
