// @allow SIZE_OK — the streaming HTTP retry loop is one cohesive transport responsibility;
// its deeply intertwined attempt/lease/reader/abort state makes extraction require a 15+
// field mutable context object passed through every sub-function, adding harmful indirection.
import {
  getEnvironmentInfo,
  messagesToCC,
  parseStreamEventLine,
  systemPromptToText,
  toolsToJson,
} from "../converters.ts"
import type {
  AssistantMessageEventStreamLike,
  ContextLike,
  CoreDependencies,
  ModelLike,
  StreamOptions,
} from "../types.ts"
import { ResponseAccumulator } from "./response-accumulator.ts"
import {
  abortError,
  DEFAULT_MAX_RETRIES,
  effectiveMaxRetryDelayMs,
  generateMaxTokens,
  headersToRecord,
  isFailoverStatus,
  MAX_RESOLVER_ATTEMPTS,
  parseRetryAfterSeconds,
  resolveApiKey,
  retryDelayMs,
  successStopReason,
  timeoutError,
} from "./policy.ts"

export interface TransportContext {
  deps: CoreDependencies
  apiBase: string
  model: ModelLike
  context: ContextLike
  options: StreamOptions | undefined
  stream: AssistantMessageEventStreamLike
  acc: ResponseAccumulator
  apiKeySource: string | ((...args: unknown[]) => Promise<unknown>) | undefined
}

export function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(abortError())
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortError())
    signal.addEventListener("abort", onAbort, { once: true })
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort)
        resolve(value)
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort)
        reject(error)
      },
    )
  })
}

function defaultDelay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(abortError())
  return new Promise<void>((resolve, reject) => {
    const id = setTimeout(() => {
      signal.removeEventListener("abort", onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(id)
      reject(abortError())
    }
    signal.addEventListener("abort", onAbort, { once: true })
  })
}

export async function executeTransport(ctx: TransportContext): Promise<void> {
  const { deps, apiBase, model, context, options, stream, acc, apiKeySource } = ctx
  // Precedence: host per-request fetch > injected fetchImpl > global fetch.
  const fetchImpl = typeof options?.fetch === "function" ? options.fetch : (deps.fetchImpl ?? fetch)
  const cwd = deps.cwd ?? (() => process.cwd())
  const now = deps.now ?? (() => Date.now())
  const uuid = deps.uuid ?? (() => crypto.randomUUID())
  const delay = deps.delay ?? defaultDelay
  const controller = new AbortController()
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined

  const abortUpstream = () => {
    if (!controller.signal.aborted) controller.abort()
    try {
      reader?.cancel().catch(() => undefined)
    } catch {
      // Reader cancellation is best-effort.
    }
  }
  if (options?.signal?.aborted) abortUpstream()
  else options?.signal?.addEventListener("abort", abortUpstream, { once: true })

  try {
    acc.pushStart()
    const workingDir = cwd()
    let body: unknown = {
      config: {
        workingDir,
        date: new Date(now()).toISOString().split("T")[0],
        environment: getEnvironmentInfo(),
        structure: [],
        isGitRepo: false,
        currentBranch: "",
        mainBranch: "",
        gitStatus: "",
        recentCommits: [],
      },
      memory: null,
      taste: null,
      skills: null,
      params: {
        model: model.id,
        messages: messagesToCC(context.messages),
        tools: toolsToJson(context.tools),
        system: systemPromptToText(context.systemPrompt),
        max_tokens: generateMaxTokens(model, options),
        temperature: 0.3,
        stream: true,
      },
      threadId: uuid(),
    }
    const nextBody = await raceAbort(
      Promise.resolve(options?.onPayload?.(body, model)),
      controller.signal,
    )
    if (nextBody !== undefined) body = nextBody

    const maxRetries = options?.maxRetries ?? DEFAULT_MAX_RETRIES
    const maxRetryDelayMs = effectiveMaxRetryDelayMs(options?.maxRetryDelayMs)
    const timeoutMs = options?.timeoutMs
    const bodyStr = JSON.stringify(body)
    const projectSlug = projectSlugFromPath(workingDir)

    let response!: Response
    retryLoop: for (let attempt = 0; ; attempt++) {
      const lease = await raceAbort(resolveApiKey(apiKeySource as never), controller.signal)
      if (!lease) throw new Error("No healthy Command Code accounts")
      const requestHeaders: Record<string, string> = {
        "Content-Type": "application/json",
        Authorization: `Bearer ${lease.token}`,
        "x-command-code-version": "0.29.0",
        "x-cli-environment": "production",
        "x-project-slug": projectSlug,
        "x-taste-learning": "true",
        "x-co-flag": "false",
      }
      // Host header overrides. Per the ProviderHeaders contract a null value
      // suppresses the corresponding default header; otherwise the value
      // overrides it.
      if (options?.headers) {
        for (const [key, value] of Object.entries(options.headers)) {
          if (value === null) {
            // HTTP headers are case-insensitive: drop any default of the same name.
            const lower = key.toLowerCase()
            for (const existing of Object.keys(requestHeaders)) {
              if (existing.toLowerCase() === lower) delete requestHeaders[existing]
            }
          } else {
            requestHeaders[key] = value
          }
        }
      }
      const attemptController = new AbortController()
      let attemptTimedOut = false
      let attemptTimeoutId: ReturnType<typeof setTimeout> | undefined
      const clearAttemptTimeout = () => {
        if (attemptTimeoutId !== undefined) {
          clearTimeout(attemptTimeoutId)
          attemptTimeoutId = undefined
        }
      }
      if (timeoutMs !== undefined) {
        attemptTimeoutId = setTimeout(() => {
          attemptTimedOut = true
          attemptController.abort()
        }, timeoutMs)
      }
      const onOuterAbort = () => attemptController.abort()
      controller.signal.addEventListener("abort", onOuterAbort, { once: true })

      try {
        try {
          response = await fetchImpl(`${apiBase}/alpha/generate`, {
            method: "POST",
            headers: requestHeaders,
            body: bodyStr,
            signal: attemptController.signal,
          })
        } catch (fetchError: unknown) {
          if (controller.signal.aborted) throw abortError("Aborted")
          if (attemptTimedOut) {
            if (
              attempt < maxRetries ||
              (typeof apiKeySource === "function" && attempt + 1 < MAX_RESOLVER_ATTEMPTS)
            ) {
              await lease.quarantine?.(now() + 30_000)
              continue retryLoop
            }
            throw timeoutError(timeoutMs)
          }
          if (typeof apiKeySource === "function" && attempt + 1 < MAX_RESOLVER_ATTEMPTS) {
            await lease.quarantine?.(now() + 30_000)
            continue retryLoop
          }
          throw fetchError
        }

        if (!response.ok && isFailoverStatus(response.status)) {
          const retryAfter = response.headers.get("retry-after")
          const waitMs =
            response.status === 401 || response.status === 403
              ? 0
              : retryDelayMs(attempt, retryAfter, maxRetryDelayMs)
          if (waitMs < 0) {
            const requestedSeconds = parseRetryAfterSeconds(retryAfter) ?? 0
            if (typeof apiKeySource === "function" && attempt + 1 < MAX_RESOLVER_ATTEMPTS) {
              await response.body?.cancel().catch(() => undefined)
              if (controller.signal.aborted) throw abortError("Aborted")
              await lease.quarantine?.(now() + Math.round(requestedSeconds * 1000))
              continue retryLoop
            }
            const capLabel =
              maxRetryDelayMs === Number.POSITIVE_INFINITY ? "disabled" : `${maxRetryDelayMs}ms`
            throw new Error(`Retry-After delay ${requestedSeconds}s exceeds max ${capLabel}`)
          }
          if (
            attempt < maxRetries ||
            (typeof apiKeySource === "function" && attempt + 1 < MAX_RESOLVER_ATTEMPTS)
          ) {
            await response.body?.cancel().catch(() => undefined)
            if (controller.signal.aborted) throw abortError("Aborted")
            const quarantineMs =
              response.status === 401 || response.status === 403
                ? 300_000
                : Math.max(Math.round(waitMs), 30_000)
            await lease.quarantine?.(now() + quarantineMs)
            if (waitMs > 0 && typeof apiKeySource !== "function") {
              await delay(waitMs, controller.signal)
            }
            continue retryLoop
          }
        }

        await raceAbort(
          Promise.resolve(
            options?.onResponse?.(
              { status: response.status, headers: headersToRecord(response.headers) },
              model,
            ),
          ),
          controller.signal,
        )

        if (!response.ok) {
          await raceAbort(
            response.text().catch(() => ""),
            controller.signal,
          )
          throw new Error(
            `Command Code API error ${response.status}: ${response.statusText || "request failed"}`,
          )
        }

        reader = response.body?.getReader()
        if (!reader) throw new Error("No response body")
        const decoder = new TextDecoder()
        let buffer = ""

        try {
          readLoop: for (;;) {
            if (controller.signal.aborted) throw abortError("Aborted")
            const { done, value } = await raceAbort(reader.read(), attemptController.signal)
            if (done) {
              if (buffer.trim()) acc.handle(parseStreamEventLine(buffer))
              break
            }
            if (controller.signal.aborted) throw abortError("Aborted")
            buffer += decoder.decode(value, { stream: true })
            const lines = buffer.split("\n")
            buffer = lines.pop() ?? ""
            for (const line of lines) {
              if (controller.signal.aborted) throw abortError("Aborted")
              acc.handle(parseStreamEventLine(line))
              if (acc.finished) break readLoop
            }
          }
        } catch (streamError: unknown) {
          await reader.cancel().catch(() => {})
          try {
            reader.releaseLock()
          } catch {}
          reader = undefined
          if (controller.signal.aborted) throw streamError
          const canRetry =
            !acc.hasVisibleContent &&
            (attempt < maxRetries ||
              (typeof apiKeySource === "function" && attempt + 1 < MAX_RESOLVER_ATTEMPTS))
          if (canRetry) {
            acc.reset()
            const waitMs = attemptTimedOut ? 0 : retryDelayMs(attempt, null, maxRetryDelayMs)
            await lease.quarantine?.(now() + Math.max(Math.round(waitMs), 30_000))
            if (waitMs > 0 && typeof apiKeySource !== "function") {
              await delay(waitMs, controller.signal)
            }
            continue retryLoop
          }
          if (attemptTimedOut) throw timeoutError(timeoutMs)
          throw streamError
        }

        if (!acc.finished) {
          if (!acc.hasVisibleContent) {
            const canRetry =
              attempt < maxRetries ||
              (typeof apiKeySource === "function" && attempt + 1 < MAX_RESOLVER_ATTEMPTS)
            if (canRetry) {
              if (controller.signal.aborted) throw abortError("Aborted")
              await lease.quarantine?.(now() + 30_000)
              continue retryLoop
            }
          }
          throw new Error("Command Code stream ended without a finish event")
        }

        acc.endTextBlock()
        acc.endThinking()
        stream.push({
          type: "done",
          reason: successStopReason(acc.output.stopReason),
          message: acc.output,
        })
        stream.end()
        break retryLoop
      } finally {
        controller.signal.removeEventListener("abort", onOuterAbort)
        clearAttemptTimeout()
      }
    }
  } catch (error: unknown) {
    const reason = controller.signal.aborted ? "aborted" : "error"
    acc.output.stopReason = reason
    acc.output.errorMessage =
      reason === "aborted"
        ? "Request aborted"
        : error instanceof Error
          ? error.message
          : String(error)
    stream.push({ type: "error", reason, error: acc.output })
    stream.end()
  } finally {
    // Drop the upstream abort listener now that the stream is terminal;
    // abortUpstream must not outlive this request (also no-ops if already fired).
    options?.signal?.removeEventListener("abort", abortUpstream)
    if (reader) {
      await reader.cancel().catch(() => undefined)
      try {
        reader.releaseLock()
      } catch {
        // ReleaseLock can throw if already released; safe to ignore.
      }
    }
  }
}

function projectSlugFromPath(pathName: string): string {
  const slug = pathName
    .toLowerCase()
    .replace(/^[a-z]:/i, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
  return slug || "project"
}
