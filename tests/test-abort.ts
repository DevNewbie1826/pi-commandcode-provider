/**
 * Abort tests against the real streamCommandCode core.
 */

import assert from "node:assert/strict"
import { after, before, beforeEach, describe, it } from "node:test"

import type { AssistantMessageEvent } from "../src/core.ts"
import {
  collectEvents,
  createTestDeps,
  makeContext,
  makeModel,
  startMockCommandCodeServer,
  type MockCommandCodeServer,
} from "./helpers.ts"

let server: MockCommandCodeServer

before(async () => {
  server = await startMockCommandCodeServer()
})

after(async () => {
  await server.close()
})

beforeEach(() => {
  server.reset()
})

describe("streamCommandCode — abort behavior", () => {
  it("emits aborted error when signal is already aborted", async () => {
    const controller = new AbortController()
    controller.abort()
    const { streamCommandCode } = createTestDeps({ apiBase: server.baseUrl() })

    const events = await collectEvents(
      streamCommandCode(makeModel(), makeContext(), {
        apiKey: "mock-key",
        signal: controller.signal,
      }),
    )

    assert.deepEqual(
      events.map((event) => event.type),
      ["start", "error"],
    )
    const error = events.at(-1)
    assert.equal(error?.type, "error")
    if (error?.type !== "error") throw new Error("expected error")
    assert.equal(error.reason, "aborted")
    assert.equal(error.error.stopReason, "aborted")
    assert.equal(server.requestCount(), 0)
  })

  it("emits aborted error and cancels the response reader mid-stream", async () => {
    server.mockResponse({
      type: "success",
      events: [JSON.stringify({ type: "text-delta", text: "first" })],
      hangAfterLast: true,
    })
    const controller = new AbortController()
    const { streamCommandCode } = createTestDeps({ apiBase: server.baseUrl() })

    const stream = streamCommandCode(makeModel(), makeContext(), {
      apiKey: "mock-key",
      signal: controller.signal,
    })

    setTimeout(() => controller.abort(), 50)
    const events = await collectEvents(stream, 2_000)

    assert.ok(
      events.some((event) => event.type === "text_delta"),
      "stream should process data before abort",
    )
    const error = events.at(-1)
    assert.equal(error?.type, "error")
    if (error?.type !== "error") throw new Error("expected error")
    assert.equal(error.reason, "aborted")
    assert.equal(error.error.errorMessage, "Request aborted")
    await new Promise((resolve) => setTimeout(resolve, 50))
    assert.ok(server.responseClosedBeforeEnd(), "abort should close the hanging upstream response")
  })

  it("terminates cleanly when aborted right after the first emitted chunk", async () => {
    server.mockResponse({
      type: "success",
      events: [JSON.stringify({ type: "text-delta", text: "first" })],
      hangAfterLast: true,
    })
    const controller = new AbortController()
    const { streamCommandCode } = createTestDeps({ apiBase: server.baseUrl() })

    const stream = streamCommandCode(makeModel(), makeContext(), {
      apiKey: "mock-key",
      signal: controller.signal,
    })

    // Iterate manually so the abort is synchronized with the FIRST chunk
    // (no fixed-timer race): abort fires exactly when the text_delta is seen.
    const events: AssistantMessageEvent[] = []
    let firstChunkObserved = false
    const collected = (async () => {
      for await (const event of stream) {
        events.push(event)
        if (!firstChunkObserved && event.type === "text_delta") {
          firstChunkObserved = true
          controller.abort()
        }
        if (event.type === "done" || event.type === "error") break
      }
      return events
    })()

    let rejectDeadline: (error: unknown) => void
    const deadlinePromise = new Promise<never>((_, reject) => {
      rejectDeadline = reject
    })
    const deadline = setTimeout(
      () => rejectDeadline!(new Error("stream did not terminate cleanly after abort")),
      2_000,
    )
    await Promise.race([collected, deadlinePromise])
    clearTimeout(deadline)

    assert.ok(firstChunkObserved, "first text_delta must be observed before abort")
    const error = events.at(-1)
    assert.equal(error?.type, "error")
    if (error?.type !== "error") throw new Error("expected error")
    assert.equal(error.reason, "aborted")
    assert.equal(error.error.errorMessage, "Request aborted")
    // Aborting must not trigger a retry with another request.
    assert.equal(server.requestCount(), 1)
    await new Promise((resolve) => setTimeout(resolve, 50))
    assert.ok(server.responseClosedBeforeEnd(), "abort should close the hanging upstream response")
  })
})
