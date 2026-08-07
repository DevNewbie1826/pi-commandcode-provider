import { expect, test } from "bun:test"
import { mkdtemp, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { collectEvents, createTestDeps, makeContext, makeModel } from "../tests/helpers.ts"
import { AccountPool } from "../src/accounts/pool.ts"
import { AccountStore } from "../src/accounts/store.ts"
import { commandCodeModelsFromCache } from "../src/models.ts"

const successResponse = (): Response =>
  new Response(`${JSON.stringify({ type: "finish", finishReason: "stop" })}\n`, { status: 200 })

test("concurrent mutations through separate AccountStore instances both persist", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cc-multi-"))
  const path = join(dir, "accounts.json")
  try {
    const a = new AccountStore(path)
    const b = new AccountStore(path)
    let releaseA!: () => void
    let releaseB!: () => void
    const gateA = new Promise<void>((r) => (releaseA = r))
    const gateB = new Promise<void>((r) => (releaseB = r))
    const append = (store: AccountStore, id: string, gate: Promise<void>, release: () => void) =>
      store.mutate(async (cur) => {
        release()
        await gate
        return {
          ...cur,
          accounts: [...cur.accounts, { id, token: `t-${id}`, enabled: true }],
        }
      })

    await Promise.all([append(a, "a", gateA, releaseA), append(b, "b", gateB, releaseB)])
    const ids = (await new AccountStore(path).load()).accounts.map((x) => x.id).sort()

    expect(ids).toEqual(["a", "b"])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("quarantine preserves the longest active retryAt deadline", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cc-qm-"))
  const path = join(dir, "accounts.json")
  try {
    const store = new AccountStore(path)
    await store.replace({
      version: 1,
      cursor: 0,
      accounts: [{ id: "a", token: "ta", enabled: true }],
    })
    const pool = new AccountPool(store, () => 100)
    const l1 = await pool.next()
    const l2 = await pool.next()
    await l1.quarantine?.(1000)
    await l2.quarantine?.(200)

    const after = (await store.load()).accounts[0]
    expect(after?.retryAt).toBe(1000)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("OAuth error callback without state is rejected and does not settle waitForCallback", async () => {
  const { startAuthServer } = await import("../src/auth-server.ts")
  const a = await startAuthServer({ startPort: 0, expectedState: "known-state" })
  try {
    let rejected: unknown = undefined
    a.waitForCallback.catch((e: unknown) => {
      rejected = e
    })
    const res = await fetch(`http://127.0.0.1:${a.port}/callback`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ error: "access_denied", error_description: "forced" }),
    })
    await new Promise((r) => setTimeout(r, 50))

    expect(res.status >= 400).toBe(true)
    expect(rejected).toBeUndefined()
  } finally {
    await new Promise<void>((r) => a.server.close(() => r()))
  }
})

test("clean EOF without a finish event retries or errors, never emits done", async () => {
  let fetchCount = 0
  const { streamCommandCode } = createTestDeps({
    fetchImpl: async () => {
      fetchCount += 1
      return new Response("", { status: 200 })
    },
  })
  const events = await collectEvents(
    streamCommandCode(makeModel(), makeContext(), { apiKey: "k", maxRetries: 1 }),
  )

  expect(events.at(-1)?.type).toBe("error")
  expect(fetchCount).toBe(2)
})

test("aborting during API key resolution emits a terminal aborted error", async () => {
  let fetchCount = 0
  const ac = new AbortController()
  const resolver = async () => {
    await new Promise((r) => setTimeout(r, 5))
    ac.abort()
    // Stay pending: a real host may not return after abort.
    await new Promise(() => {})
    return "x"
  }
  const { streamCommandCode } = createTestDeps({
    fetchImpl: async () => {
      fetchCount += 1
      return successResponse()
    },
  })

  const events = await collectEvents(
    streamCommandCode(makeModel(), makeContext(), { apiKey: resolver, signal: ac.signal }),
  )

  expect(fetchCount).toBe(0)
  expect(events.at(-1)?.type).toBe("error")
})

test("retryable HTTP error with an open body fails over within a bounded time", async () => {
  const enc = new TextEncoder()
  let fetchCount = 0
  let cancelCalled = false
  const ac = new AbortController()
  const { streamCommandCode } = createTestDeps({
    fetchImpl: async () => {
      fetchCount += 1
      if (fetchCount === 1) {
        const body = new ReadableStream<Uint8Array>({
          pull(controller) {
            controller.enqueue(enc.encode("slow"))
          },
          cancel() {
            cancelCalled = true
          },
        })
        return new Response(body, { status: 429, headers: { "retry-after": "0" } })
      }
      return successResponse()
    },
  })

  // Hard-cap the wait so a still-broken failover cannot hang the suite; if it
  // fires, abort the stream so the underlying fetch body unwinds.
  const timeout = setTimeout(() => ac.abort(), 1_500)

  try {
    const events = await collectEvents(
      streamCommandCode(makeModel(), makeContext(), {
        apiKey: "k",
        maxRetries: 1,
        signal: ac.signal,
      }),
    )
    expect(fetchCount).toBe(2)
    expect(cancelCalled).toBe(true)
    expect(events.at(-1)?.type).toBe("done")
  } finally {
    clearTimeout(timeout)
  }
})

test("cache parsing rejects models with maxTokens greater than contextWindow", () => {
  expect(() =>
    commandCodeModelsFromCache({
      version: 1,
      models: [{ id: "m", name: "M", reasoning: true, contextWindow: 1, maxTokens: 65536 }],
    }),
  ).toThrow()
})

test("a synchronous onAuth throw closes the OAuth callback server", async () => {
  const { login } = await import("../src/oauth.ts")
  let capturedUrl = ""
  const promise = login({
    onAuth: ({ url }) => {
      capturedUrl = url
      throw new Error("host boom")
    },
    onPrompt: async () => "ignored",
  })
  let threw = false
  try {
    await promise
  } catch {
    threw = true
  }
  expect(threw).toBe(true)
  expect(capturedUrl).not.toBe("")
  const cbMatch = capturedUrl.match(/callback=http[^&]*localhost%3A(\d+)/)
  const port = cbMatch ? Number(cbMatch[1]) : 0
  if (port) {
    const { createServer } = await import("node:http")
    await new Promise<void>((resolve, reject) => {
      const probe = createServer()
      probe.once("error", reject)
      probe.listen(port, "127.0.0.1", () => probe.close(() => resolve()))
    })
  }
})

test("a failed write or sync removes the temporary credential file", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cc-tmp-"))
  const path = join(dir, "accounts.json")
  // Intercept FileHandle.prototype.sync so the temp file is created but
  // sync() rejects. This exercises the failure path between temp-file
  // creation and rename that previously bypassed tempPath cleanup.
  const fsPromises = await import("node:fs/promises")
  const FileHandleProto = Object.getPrototypeOf(await fsPromises.open(dir, "r"))
  const realSync = FileHandleProto.sync
  let injected = false
  FileHandleProto.sync = async function (...args: unknown[]) {
    if (!injected) {
      injected = true
      throw new Error("injected sync failure")
    }
    return (realSync as (...a: unknown[]) => Promise<void>).apply(this, args)
  }
  try {
    const store = new AccountStore(path)
    let threw = false
    try {
      await store.replace({
        version: 1,
        cursor: 0,
        accounts: [{ id: "a", token: "ta", enabled: true }],
      })
    } catch {
      threw = true
    }
    expect(threw).toBe(true)

    const entries = await readdir(dir)
    const leftoverTmp = entries.some((e) => e.endsWith(".tmp"))
    expect(leftoverTmp).toBe(false)
  } finally {
    FileHandleProto.sync = realSync
    await rm(dir, { recursive: true, force: true })
  }
})
