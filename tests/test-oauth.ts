/**
 * Tests for the Command Code OAuth / browser auth flow.
 *
 * Tests the local callback server (src/auth-server.ts) and the OAuth
 * integration functions (src/oauth.ts).
 */

import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { startAuthServer, type AuthCallback } from "../src/auth-server.ts"
import { getApiKey, login, refreshToken, sanitizeApiKey } from "../src/oauth.ts"

/**
 * Helper: wait for an HTTP server to close, or resolve immediately if already closed.
 */
function waitForClose(server: {
  listening: boolean
  on(event: "close", cb: () => void): void
}): Promise<void> {
  return new Promise((resolve) => {
    if (!server.listening) return resolve(undefined)
    server.on("close", resolve)
  })
}

describe("startAuthServer()", () => {
  it("starts on a localhost port and accepts a valid callback POST", async () => {
    const { server, port, waitForCallback } = await startAuthServer({ startPort: 0 })

    const callbackData: AuthCallback = {
      apiKey: "user_testKey123",
      state: "test-state-token",
      userId: "user_123",
      userName: "Test User",
      keyName: "test-key",
    }

    // Simulate the Command Code Studio posting the API key back
    const response = await fetch(`http://127.0.0.1:${port}/callback`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "https://commandcode.ai" },
      body: JSON.stringify(callbackData),
    })

    assert.equal(response.status, 200)
    const body = (await response.json()) as { success: boolean }
    assert.equal(body.success, true)

    const result = await waitForCallback
    assert.equal(result.apiKey, "user_testKey123")
    assert.equal(result.state, "test-state-token")
    assert.equal(result.userId, "user_123")
    assert.equal(result.userName, "Test User")
    assert.equal(result.keyName, "test-key")

    await waitForClose(server)
  })

  it("rejects when the callback indicates access_denied", async () => {
    const { server, port, waitForCallback } = await startAuthServer({ startPort: 0 })

    // Attach rejection handler before posting to avoid unhandled rejection
    const errorPromise: Promise<string> = waitForCallback.then(
      () => {
        throw new Error("Expected callback to reject")
      },
      (e: Error) => e.message,
    )

    const response = await fetch(`http://127.0.0.1:${port}/callback`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "https://commandcode.ai" },
      body: JSON.stringify({ error: "access_denied", error_description: "User cancelled" }),
    })

    assert.equal(response.status, 200)

    const errorMsg = await errorPromise
    assert.match(errorMsg, /User cancelled/)

    await waitForClose(server)
  })

  it("returns 400 for missing required fields", async () => {
    const { server, port } = await startAuthServer({ startPort: 0 })

    const response = await fetch(`http://127.0.0.1:${port}/callback`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "https://commandcode.ai" },
      body: JSON.stringify({ apiKey: "key", state: "s" }),
    })

    assert.equal(response.status, 400)

    await new Promise((resolve) => setTimeout(resolve, 100))
    server.close()
  })

  it("handles CORS and private-network preflight OPTIONS request", async () => {
    const { server, port } = await startAuthServer({ startPort: 0 })

    const response = await fetch(`http://127.0.0.1:${port}/callback`, {
      method: "OPTIONS",
      headers: {
        Origin: "https://commandcode.ai",
        "Access-Control-Request-Headers": "content-type,x-requested-with",
        "Access-Control-Request-Private-Network": "true",
      },
    })

    assert.equal(response.status, 204)
    assert.equal(response.headers.get("access-control-allow-origin"), "https://commandcode.ai")
    assert.equal(
      response.headers.get("access-control-allow-headers"),
      "content-type,x-requested-with",
    )
    assert.equal(response.headers.get("access-control-allow-private-network"), "true")

    await new Promise((resolve) => setTimeout(resolve, 100))
    server.close()
  })

  it("returns 404 for non-callback paths", async () => {
    const { server, port } = await startAuthServer({ startPort: 0 })

    const response = await fetch(`http://127.0.0.1:${port}/other`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    })

    assert.equal(response.status, 404)

    await new Promise((resolve) => setTimeout(resolve, 100))
    server.close()
  })

  it("returns 405 for GET on /callback", async () => {
    const { server, port } = await startAuthServer({ startPort: 0 })

    const response = await fetch(`http://127.0.0.1:${port}/callback`, {
      method: "GET",
      headers: { Origin: "https://commandcode.ai" },
    })

    assert.equal(response.status, 405)

    await new Promise((resolve) => setTimeout(resolve, 100))
    server.close()
  })
})

describe("OAuth functions", () => {
  it("getApiKey returns the access token", () => {
    const creds = {
      refresh: "refresh-key",
      access: "access-key",
      expires: Date.now() + 3600000,
    }
    assert.equal(getApiKey(creds), "access-key")
  })

  it("refreshToken returns updated far-future expiry", async () => {
    const creds = {
      refresh: "my-api-key",
      access: "my-api-key",
      expires: Date.now() - 1000, // already expired
    }
    const result = await refreshToken(creds)
    assert.equal(result.access, "my-api-key")
    assert.equal(result.refresh, "my-api-key")
    assert.ok(result.expires > Date.now(), "expiry should be in the future")
  })

  it("sanitizeApiKey removes paste markers, control chars, and whitespace", () => {
    assert.equal(sanitizeApiKey("\u001b[200~  user_manualKey\n\u001b[201~"), "user_manualKey")
  })
})

describe("login()", () => {
  it("completes the full browser login flow via the local server", async () => {
    let authUrl = ""
    const callbacks = {
      onAuth(params: { url: string }) {
        authUrl = params.url
      },
      onPrompt(_params: { message: string }): Promise<string> {
        throw new Error("onPrompt should not be called in browser flow")
      },
    }

    // Start login in the background
    const loginPromise = login(callbacks)

    // Wait for onAuth to be called (it fires asynchronously after the auth server starts)
    while (!authUrl) await new Promise((resolve) => setTimeout(resolve, 10))

    // Verify the auth URL was passed to callbacks (callback URL is encoded)
    assert.match(
      authUrl,
      /^https:\/\/commandcode\.ai\/studio\/auth\/cli\?callback=http%3A%2F%2Flocalhost%3A\d+%2Fcallback&state=/,
    )

    const url = new URL(authUrl)
    const port = parseInt(url.searchParams.get("callback")?.match(/localhost:(\d+)/)?.[1] ?? "0")
    const state = url.searchParams.get("state") ?? ""

    assert.ok(port > 0, "auth server should be on a non-zero port")
    assert.ok(state.length > 0, "state token should not be empty")

    // Simulate the Command Code Studio posting the API key back
    const response = await fetch(`http://127.0.0.1:${port}/callback`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: "https://commandcode.ai",
      },
      body: JSON.stringify({
        apiKey: "user_browserApiKey",
        state,
        userId: "user_456",
        userName: "Browser User",
        keyName: "browser-key",
      }),
    })

    assert.equal(response.status, 200)

    const result = await loginPromise
    assert.equal(result.access, "user_browserApiKey")
    assert.equal(result.refresh, "user_browserApiKey")
    assert.ok(result.expires > Date.now(), "expiry should be far in the future")
  })

  it("prompts for a manual API key if browser transfer times out", async () => {
    const originalTimeout = process.env.COMMANDCODE_AUTH_TIMEOUT_MS
    process.env.COMMANDCODE_AUTH_TIMEOUT_MS = "1"

    let authUrl = ""
    let promptMessage = ""

    try {
      const result = await login({
        onAuth(params: { url: string }) {
          authUrl = params.url
        },
        async onPrompt(params: { message: string }): Promise<string> {
          promptMessage = params.message
          return "\u001b[200~  user_manualApiKey\n\u001b[201~"
        },
      })

      assert.match(authUrl, /^https:\/\/commandcode\.ai\/studio\/auth\/cli\?/)
      assert.match(promptMessage, /Paste your Command Code API key/)
      assert.equal(result.access, "user_manualApiKey")
      assert.equal(result.refresh, "user_manualApiKey")
      assert.ok(result.expires > Date.now(), "expiry should be far in the future")
    } finally {
      if (originalTimeout === undefined) delete process.env.COMMANDCODE_AUTH_TIMEOUT_MS
      else process.env.COMMANDCODE_AUTH_TIMEOUT_MS = originalTimeout
    }
  })

  it("rejects a mismatched state callback without substituting the credential", async () => {
    const originalTimeout = process.env.COMMANDCODE_AUTH_TIMEOUT_MS
    process.env.COMMANDCODE_AUTH_TIMEOUT_MS = "500"

    let authUrl = ""
    let promptMessage = ""

    try {
      const loginPromise = login({
        onAuth(params: { url: string }) {
          authUrl = params.url
        },
        async onPrompt(params: { message: string }): Promise<string> {
          promptMessage = params.message
          return "user_manualApiKey"
        },
      })

      // Wait for onAuth to be called asynchronously
      while (!authUrl) {
        await new Promise<void>((resolve) => setTimeout(resolve, 10))
      }

      const url = new URL(authUrl)
      const port = parseInt(url.searchParams.get("callback")?.match(/localhost:(\d+)/)?.[1] ?? "0")

      // Post back with a wrong state token: the server rejects it and keeps
      // waiting for a callback that carries the expected state.
      const response = await fetch(`http://127.0.0.1:${port}/callback`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: "https://commandcode.ai" },
        body: JSON.stringify({
          apiKey: "user_badState",
          state: "wrong-state-token",
          userId: "user_789",
          userName: "Attacker",
          keyName: "evil-key",
        }),
      })

      assert.equal(response.status, 403)
      const body = (await response.json()) as { success: boolean; error: string }
      assert.equal(body.success, false)
      assert.equal(body.error, "Invalid state")

      // The mismatched callback never settles the flow, so it times out and falls
      // back to the manual prompt; the mismatched credential must NOT be used.
      const result = await loginPromise
      assert.match(promptMessage, /Automatic transfer failed or timed out/)
      assert.equal(result.access, "user_manualApiKey")
      assert.equal(result.refresh, "user_manualApiKey")
    } finally {
      if (originalTimeout === undefined) delete process.env.COMMANDCODE_AUTH_TIMEOUT_MS
      else process.env.COMMANDCODE_AUTH_TIMEOUT_MS = originalTimeout
    }
  })
})
