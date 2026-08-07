import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { AccountPool, NoHealthyAccountsError } from "../src/accounts/pool.ts"
import { AccountStore } from "../src/accounts/store.ts"
import { MAX_DATE_MS } from "../src/accounts/schema.ts"
import { collectEvents, createTestDeps, makeContext, makeModel } from "../tests/helpers.ts"

const accountIds = ["work", "personal", "backup"]

const healthyAccounts = accountIds.map((id) => ({ id, token: `token-${id}`, enabled: true }))

const successResponse = (): Response =>
  new Response(`${JSON.stringify({ type: "finish", finishReason: "stop" })}\n`, {
    status: 200,
  })

test("rotates healthy accounts deterministically", async () => {
  const accountIds = ["qa-alpha", "qa-beta"]
  const tokens = ["token-a", "token-b"]
  const authorizationHeaders: string[] = []
  let cursor = 0

  const resolver = async () => {
    const token = tokens[cursor]
    cursor = (cursor + 1) % tokens.length
    return token
  }
  const fetchImpl = async (_input: string | URL | Request, init?: RequestInit) => {
    authorizationHeaders.push(new Headers(init?.headers).get("authorization") ?? "")
    return successResponse()
  }
  const { streamCommandCode } = createTestDeps({ fetchImpl })

  await collectEvents(
    streamCommandCode(makeModel(), makeContext(), {
      apiKey: resolver,
    }),
  )
  await collectEvents(
    streamCommandCode(makeModel(), makeContext(), {
      apiKey: resolver,
    }),
  )

  expect(authorizationHeaders).toEqual(tokens.map((token) => `Bearer ${token}`))
  expect(accountIds).toEqual(["qa-alpha", "qa-beta"])
})

test("quarantines retryable failures and fails over", async () => {
  const tokens = ["token-a", "token-b"]
  const attempts: string[] = []
  let resolverCalls = 0

  const resolver = async () => {
    const token = tokens[resolverCalls]
    resolverCalls += 1
    return token
  }
  const fetchImpl = async (_input: string | URL | Request, init?: RequestInit) => {
    const authorization = new Headers(init?.headers).get("authorization") ?? ""
    attempts.push(authorization.replace(/^Bearer /, ""))
    if (attempts.length === 1) {
      return new Response("rate limited", {
        status: 429,
        headers: { "retry-after": "0" },
      })
    }
    return successResponse()
  }
  const { streamCommandCode } = createTestDeps({ fetchImpl })

  const events = await collectEvents(
    streamCommandCode(makeModel(), makeContext(), {
      apiKey: resolver,
      maxRetries: 2,
    }),
  )

  expect(events.at(-1)?.type).toBe("done")
  expect(attempts).toEqual(tokens)
  expect(resolverCalls).toBe(2)
})

test("fails over when Retry-After exceeds the single-key cap", async () => {
  const tokens = ["token-a", "token-b"]
  const attempts: string[] = []
  let resolverCalls = 0
  const resolver = async () => {
    const token = tokens[resolverCalls]
    resolverCalls += 1
    return token
  }
  const fetchImpl = async (_input: string | URL | Request, init?: RequestInit) => {
    attempts.push((new Headers(init?.headers).get("authorization") ?? "").replace(/^Bearer /, ""))
    if (attempts.length === 1) {
      return new Response("rate limited", {
        status: 429,
        headers: { "retry-after": "3600" },
      })
    }
    return successResponse()
  }
  const { streamCommandCode } = createTestDeps({ fetchImpl })

  const events = await collectEvents(
    streamCommandCode(makeModel(), makeContext(), {
      apiKey: resolver,
      maxRetryDelayMs: 100,
    }),
  )

  expect(events.at(-1)?.type).toBe("done")
  expect(attempts).toEqual(tokens)
})

test("fails over on a pre-content stream error", async () => {
  const tokens = ["token-a", "token-b"]
  const attempts: string[] = []
  let resolverCalls = 0
  const resolver = async () => {
    const token = tokens[resolverCalls]
    resolverCalls += 1
    return token
  }
  const fetchImpl = async (_input: string | URL | Request, init?: RequestInit) => {
    attempts.push((new Headers(init?.headers).get("authorization") ?? "").replace(/^Bearer /, ""))
    if (attempts.length === 1) {
      return new Response(
        `${JSON.stringify({
          type: "error",
          error: "Service temporarily unavailable. Please try again shortly.",
        })}\n`,
        { status: 200 },
      )
    }
    return successResponse()
  }
  const { streamCommandCode } = createTestDeps({ fetchImpl })

  const events = await collectEvents(
    streamCommandCode(makeModel(), makeContext(), {
      apiKey: resolver,
    }),
  )

  expect(events.at(-1)?.type).toBe("done")
  expect(attempts).toEqual(tokens)
})

test("rotates healthy accounts round-robin through AccountPool", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cc-rotate-"))
  const path = join(dir, "accounts.json")
  try {
    const store = new AccountStore(path)
    await store.replace({ version: 1, cursor: 0, accounts: healthyAccounts })

    const pool = new AccountPool(store)
    const selected: string[] = []
    for (let i = 0; i < 4; i += 1) selected.push((await pool.next()).id)

    expect(selected).toEqual(["work", "personal", "backup", "work"])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("resolver yields each healthy account once, then throws NoHealthyAccountsError", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cc-resolver-"))
  const path = join(dir, "accounts.json")
  try {
    const store = new AccountStore(path)
    await store.replace({ version: 1, cursor: 0, accounts: healthyAccounts })

    const pool = new AccountPool(store)
    const resolver = pool.resolver()

    const yielded: string[] = []
    for (let i = 0; i < accountIds.length; i += 1) {
      const lease = await resolver()
      if (typeof lease === "string") throw new Error("expected ApiKeyLease from resolver")
      yielded.push(lease.id)
    }
    expect([...yielded].sort()).toEqual([...accountIds].sort())
    await expect(resolver()).rejects.toBeInstanceOf(NoHealthyAccountsError)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("quarantine clears the sticky session so next(sameSession) leaves the quarantined account", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cc-sticky-"))
  const path = join(dir, "accounts.json")
  try {
    const store = new AccountStore(path)
    await store.replace({
      version: 1,
      cursor: 0,
      accounts: [
        { id: "a", token: "ta", enabled: true },
        { id: "b", token: "tb", enabled: true },
      ],
    })
    let now = 100
    const pool = new AccountPool(store, () => now)

    const first = await pool.next("session-1")
    expect(first.id).toBe("a")
    expect((await pool.next("session-1")).id).toBe("a")

    await first.quarantine?.(1000)
    expect((await pool.next("session-1")).id).not.toBe("a")

    // The session mapping is cleared, not merely masked by retryAt: once "a"
    // recovers, the session must still not fall back to it.
    now = 2000
    expect((await pool.next("session-1")).id).not.toBe("a")
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("quarantine clamps an out-of-range deadline to the representable Date range", async () => {
  // A hostile Retry-After can yield a deadline beyond the max Date ms;
  // quarantine must clamp it so account-file validation never fails.
  const dir = await mkdtemp(join(tmpdir(), "cc-clamp-"))
  const path = join(dir, "accounts.json")
  try {
    const store = new AccountStore(path)
    await store.replace({ version: 1, cursor: 0, accounts: healthyAccounts })

    const pool = new AccountPool(store)
    await pool.quarantine("work", Number.MAX_SAFE_INTEGER)

    const after = await store.load()
    expect(after.accounts.find((a) => a.id === "work")?.retryAt).toBe(MAX_DATE_MS)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
