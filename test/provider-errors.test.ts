import { expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

import { collectEvents, createTestDeps, makeContext, makeModel } from "../tests/helpers.ts"

test("redacts active credentials from provider errors", async () => {
  const token = "token-a-secret"
  const fetchImpl = async () =>
    new Response(`upstream rejected bearer ${token}`, {
      status: 500,
    })
  const { streamCommandCode } = createTestDeps({ fetchImpl })

  const events = await collectEvents(
    streamCommandCode(makeModel(), makeContext(), {
      apiKey: token,
    }),
  )
  const last = events.at(-1)

  expect(last?.type).toBe("error")
  if (last?.type !== "error") throw new Error("expected error")
  expect(last.error.errorMessage).toContain("500")
  expect(last.error.errorMessage).not.toContain(token)
})

test("redacts credentials from account CLI stdout and stderr", async () => {
  const token = "cli-secret-token-9f3a"
  const directory = await mkdtemp(join(tmpdir(), "commandcode-accounts-"))
  const storePath = join(directory, "accounts.json")
  const cliPath = fileURLToPath(new URL("../src/accounts/cli.ts", import.meta.url))

  try {
    await writeFile(
      storePath,
      JSON.stringify({
        version: 1,
        cursor: 0,
        accounts: [
          {
            id: "qa-cli",
            token,
            enabled: true,
            createdAt: "2026-01-01T00:00:00.000Z",
          },
        ],
      }),
    )
    const env = { ...process.env, COMMANDCODE_ACCOUNTS_FILE: storePath }

    const list = spawnSync(process.execPath, [cliPath, "list"], {
      env,
      encoding: "utf8",
      timeout: 10_000,
    })
    expect(list.status).toBe(0)
    expect(list.stdout).toContain("qa-cli")
    expect(list.stdout).not.toContain(token)
    expect(list.stderr).not.toContain(token)

    const next = spawnSync(process.execPath, [cliPath, "next"], {
      env,
      encoding: "utf8",
      timeout: 10_000,
    })
    expect(next.status).toBe(0)
    expect(next.stdout).toContain("qa-cli")
    expect(next.stdout).not.toContain(token)
    expect(next.stderr).not.toContain(token)

    const addedToken = "cli-secret-token-added"
    const add = spawnSync(process.execPath, [cliPath, "add", "qa-cli-2", "--token", addedToken], {
      env,
      encoding: "utf8",
      timeout: 10_000,
    })
    expect(add.status).toBe(0)
    expect(add.stdout).toContain("qa-cli-2")
    expect(add.stdout).not.toContain(token)
    expect(add.stdout).not.toContain(addedToken)
    expect(add.stderr).not.toContain(token)
    expect(add.stderr).not.toContain(addedToken)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
