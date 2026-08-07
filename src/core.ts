/**
 * Testable Command Code provider core.
 *
 * The runtime imports live in index.ts; this module takes injected stream/cost
 * dependencies so tests can exercise the real serialization and stream parser.
 *
 * Retry policy: src/core/policy.ts
 * Response events: src/core/response-accumulator.ts
 * HTTP transport: src/core/transport.ts
 */

import { getApiKey } from "./converters.ts"
import { ResponseAccumulator } from "./core/response-accumulator.ts"
import { defaultUsage } from "./core/policy.ts"
import { executeTransport } from "./core/transport.ts"
import type {
  AssistantMessageEventStreamLike,
  AssistantMessageLike,
  ContextLike,
  CoreDependencies,
  ModelLike,
  StreamOptions,
} from "./types.ts"

export * from "./converters.ts"
export * from "./types.ts"
export { ResponseAccumulator } from "./core/response-accumulator.ts"
export * from "./core/policy.ts"
export { raceAbort } from "./core/transport.ts"

export const DEFAULT_API_BASE = "https://api.commandcode.ai"
export const COMMAND_CODE_CLI_VERSION = "0.29.0"

export function projectSlugFromPath(pathName: string): string {
  const slug = pathName
    .toLowerCase()
    .replace(/^[a-z]:/i, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
  return slug || "project"
}

export function createStreamCommandCode(deps: CoreDependencies) {
  const apiBase = deps.apiBase ?? DEFAULT_API_BASE

  return function streamCommandCode(
    model: ModelLike,
    context: ContextLike,
    options?: StreamOptions,
  ): AssistantMessageEventStreamLike {
    const stream = deps.createStream()

    async function run() {
      const LEGACY_API_KEY_REF = "$COMMANDCODE_API_KEY"
      const OLD_API_KEY_REF = "COMMANDCODE_API_KEY"
      const hostKey =
        options?.apiKey &&
        options.apiKey !== LEGACY_API_KEY_REF &&
        options.apiKey !== OLD_API_KEY_REF
          ? options.apiKey
          : undefined
      const apiKeySource =
        hostKey ?? getApiKey({ env: deps.env, authPaths: deps.authPaths, homeDir: deps.homeDir })

      if (!apiKeySource) {
        const msg: AssistantMessageLike = {
          role: "assistant",
          content: [],
          api: model.api,
          provider: model.provider,
          model: model.id,
          usage: defaultUsage(),
          stopReason: "error",
          errorMessage:
            "No Command Code API key. Run /login and select Command Code, set the COMMANDCODE_API_KEY env var, or configure ~/.commandcode/auth.json, ~/.pi/agent/auth.json or ~/.omp/agent/auth.json",
          timestamp: Date.now(),
        }
        stream.push({ type: "error", reason: "error", error: msg })
        stream.end()
        return
      }

      const acc = new ResponseAccumulator(stream, model, deps.calculateCost, deps.now ?? Date.now)
      await executeTransport({
        deps,
        apiBase,
        model,
        context,
        options,
        stream,
        acc,
        apiKeySource: apiKeySource as string | ((...args: unknown[]) => Promise<unknown>),
      })
    }

    run().catch((error: unknown) => {
      // Normal transport errors are funnelled through the stream by
      // executeTransport (which ends the stream itself). Only rejections that
      // escape run() before a terminal event was emitted reach here — e.g.
      // getApiKey rethrowing a validation error from a malformed credential
      // record. Swallowing those would leave the consumer waiting on a stream
      // that never ends, so emit a terminal assistant error event instead.
      const msg: AssistantMessageLike = {
        role: "assistant",
        content: [],
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage: defaultUsage(),
        stopReason: "error",
        errorMessage: error instanceof Error ? error.message : String(error),
        timestamp: deps.now?.() ?? Date.now(),
      }
      stream.push({ type: "error", reason: "error", error: msg })
      stream.end()
    })
    return stream
  }
}
