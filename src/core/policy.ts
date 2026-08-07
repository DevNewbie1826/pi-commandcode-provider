import { isRecord, numberValue, stringValue } from "../converters.ts"
import type {
  ApiKeyLease,
  ApiKeyResolver,
  ModelLike,
  StopReason,
  StreamOptions,
  TerminalReason,
  Usage,
} from "../types.ts"

export const DEFAULT_GENERATE_MAX_TOKENS = 64_000
export const DEFAULT_MAX_RETRIES = 0
export const DEFAULT_MAX_RETRY_DELAY_MS = 60_000
export const BASE_RETRY_DELAY_MS = 500
export const MAX_RESOLVER_ATTEMPTS = 32

export function isRetryableStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status < 600)
}

export function isFailoverStatus(status: number): boolean {
  return status === 401 || status === 403 || isRetryableStatus(status)
}

function isApiKeyLease(value: unknown): value is ApiKeyLease {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.token === "string" &&
    (value.quarantine === undefined || typeof value.quarantine === "function")
  )
}

export async function resolveApiKey(
  source: string | ApiKeyResolver | undefined,
): Promise<ApiKeyLease | undefined> {
  if (typeof source === "string") return { id: "explicit", token: source }
  if (source === undefined) return undefined
  const resolved = await source()
  return typeof resolved === "string"
    ? { id: "resolved", token: resolved }
    : isApiKeyLease(resolved)
      ? resolved
      : undefined
}

export function parseRetryAfterSeconds(value: string | null): number | undefined {
  if (!value) return undefined
  const seconds = Number(value)
  if (Number.isFinite(seconds) && seconds >= 0) return seconds
  const date = Date.parse(value)
  if (!Number.isNaN(date)) return Math.max(0, (date - Date.now()) / 1000)
  return undefined
}

export function effectiveMaxRetryDelayMs(value: number | undefined): number {
  if (value === undefined) return DEFAULT_MAX_RETRY_DELAY_MS
  if (value === 0) return Number.POSITIVE_INFINITY
  return value
}

export function retryDelayMs(
  attempt: number,
  retryAfterHeader: string | null,
  maxDelayMs: number,
): number {
  const retryAfterMs = parseRetryAfterSeconds(retryAfterHeader)
  if (retryAfterMs !== undefined) {
    if (retryAfterMs * 1000 > maxDelayMs) return -1
    return retryAfterMs * 1000
  }
  const exponential = BASE_RETRY_DELAY_MS * 2 ** attempt
  const jitter = exponential * 0.2 * Math.random()
  return Math.min(exponential + jitter, maxDelayMs)
}

export function defaultUsage(): Usage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  }
}

export function commandCodeUsage(
  event: Record<string, unknown>,
): Record<string, unknown> | undefined {
  return isRecord(event.totalUsage) ? event.totalUsage : undefined
}

export function commandCodeInputTokenDetails(
  usage: Record<string, unknown>,
): Record<string, unknown> | undefined {
  return isRecord(usage.inputTokenDetails) ? usage.inputTokenDetails : undefined
}

export function headersToRecord(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {}
  headers.forEach((value, key) => {
    out[key] = value
  })
  return out
}

export function abortError(message = "The operation was aborted"): DOMException {
  return new DOMException(message, "AbortError")
}

export function timeoutError(timeoutMs: number | undefined): Error {
  return new Error(
    timeoutMs === undefined
      ? "Command Code API request timed out"
      : `Command Code API request timed out after ${timeoutMs}ms`,
  )
}

export function successStopReason(reason: TerminalReason): StopReason {
  if (reason === "length" || reason === "toolUse") return reason
  return "stop"
}

export function generateMaxTokens(model: ModelLike, options?: StreamOptions): number {
  return Math.min(
    options?.maxTokens ?? model.maxTokens,
    model.maxTokens,
    DEFAULT_GENERATE_MAX_TOKENS,
  )
}

export function applyFinishUsage(
  output: { usage: Usage },
  event: Record<string, unknown>,
  calculateCost: (model: ModelLike, usage: Usage) => void,
  model: ModelLike,
): void {
  const usage = commandCodeUsage(event)
  if (!usage) return
  const details = commandCodeInputTokenDetails(usage)
  const totalInput = numberValue(usage.inputTokens) ?? 0
  const input = numberValue(details?.noCacheTokens)
  const cacheRead = numberValue(details?.cacheReadTokens) ?? 0
  const cacheWrite = numberValue(details?.cacheWriteTokens) ?? 0
  output.usage.input = input ?? Math.max(0, totalInput - cacheRead - cacheWrite)
  output.usage.output = numberValue(usage.outputTokens) ?? 0
  output.usage.cacheRead = cacheRead
  output.usage.cacheWrite = cacheWrite
  output.usage.totalTokens =
    output.usage.input + output.usage.output + output.usage.cacheRead + output.usage.cacheWrite
  calculateCost(model, output.usage)
}

export function streamErrorMessage(event: Record<string, unknown>): string {
  const errorRecord = isRecord(event.error) ? event.error : undefined
  return stringValue(errorRecord?.message) ?? stringValue(event.error) ?? "Stream error"
}
