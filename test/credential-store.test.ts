import { expect, test } from "bun:test"
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

import { AccountStore } from "../src/accounts/store.ts"
import { getApiKey } from "../src/converters.ts"

test("rejects malformed credential records", async () => {
  const directory = await mkdtemp(join(tmpdir(), "commandcode-credentials-"))
  const credentialPath = join(directory, "commandcode-accounts.json")

  try {
    await writeFile(
      credentialPath,
      JSON.stringify({
        version: 1,
        cursor: 0,
        accounts: [{ id: "qa-alpha", token: "", enabled: "yes" }],
      }),
    )

    expect(() => getApiKey({ env: {}, authPaths: [credentialPath] })).toThrow(
      "Invalid account credentials",
    )
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test("importing a malformed accounts file leaves an existing store unchanged", async () => {
  const directory = await mkdtemp(join(tmpdir(), "commandcode-credentials-"))
  const storePath = join(directory, "commandcode-accounts.json")
  const fixturePath = fileURLToPath(new URL("./fixtures/malformed-accounts.json", import.meta.url))

  try {
    const store = new AccountStore(storePath)
    await store.add({
      id: "qa-valid",
      token: "valid-token-1",
      enabled: true,
      createdAt: new Date().toISOString(),
    })
    const before = await readFile(storePath, "utf8")

    await expect(store.importFile(fixturePath)).rejects.toThrow("Invalid account credentials")

    const current = await store.load()
    expect(current.accounts).toHaveLength(1)
    expect(current.accounts[0]).toEqual(
      expect.objectContaining({ id: "qa-valid", token: "valid-token-1" }),
    )
    expect(await readFile(storePath, "utf8")).toBe(before)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test("a successfully written credential file is mode 0o600 on POSIX", async () => {
  if (process.platform === "win32") return
  const dir = await mkdtemp(join(tmpdir(), "cc-perm-"))
  const path = join(dir, "accounts.json")
  try {
    const store = new AccountStore(path)
    await store.replace({
      version: 1,
      cursor: 0,
      accounts: [{ id: "a", token: "ta", enabled: true }],
    })

    const mode = (await stat(path)).mode & 0o777
    expect(mode).toBe(0o600)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
