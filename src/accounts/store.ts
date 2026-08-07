import { randomUUID } from "node:crypto"
import { chmod, mkdir, open, readFile, rename, rm } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join } from "node:path"

import {
  type AccountFile,
  type AccountRecord,
  emptyAccountFile,
  parseAccount,
  parseAccountFile,
} from "./schema.ts"

export class CredentialStoreError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = "CredentialStoreError"
  }
}

function isMissingFile(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    Object.getOwnPropertyDescriptor(error, "code")?.value === "ENOENT"
  )
}

export function defaultAccountStorePath(home = homedir()): string {
  return join(home, ".commandcode", "accounts.json")
}

const pathLocks = new Map<string, Promise<unknown>>()

function withPathLock<T>(path: string, run: () => Promise<T>): Promise<T> {
  const previous = pathLocks.get(path) ?? Promise.resolve()
  let release: () => void = () => {}
  const next = new Promise<unknown>((resolve) => {
    release = () => resolve(undefined)
  })
  const tail = previous.then(() => next)
  pathLocks.set(path, tail)
  return previous
    .then(() => run())
    .finally(() => {
      if (pathLocks.get(path) === tail) pathLocks.delete(path)
      release()
    })
}

export class AccountStore {
  readonly #path: string
  #queue: Promise<void> = Promise.resolve()

  constructor(path = defaultAccountStorePath()) {
    this.#path = path
  }

  path(): string {
    return this.#path
  }

  async load(): Promise<AccountFile> {
    try {
      const raw = await readFile(this.#path, "utf8")
      return parseAccountFile(JSON.parse(raw))
    } catch (error) {
      if (isMissingFile(error)) return emptyAccountFile()
      if (error instanceof SyntaxError) {
        throw new CredentialStoreError("Invalid account credentials", { cause: error })
      }
      if (error instanceof Error && error.message === "Invalid account credentials") {
        throw new CredentialStoreError(error.message, { cause: error })
      }
      throw error
    }
  }

  async replace(value: unknown): Promise<AccountFile> {
    const parsed = parseAccountFile(value)
    return await this.#update(async () => parsed)
  }

  async add(value: unknown): Promise<AccountRecord> {
    const account = parseAccount(value)
    await this.#update(async (current) => {
      if (current.accounts.some((candidate) => candidate.id === account.id)) {
        throw new CredentialStoreError(`Account already exists: ${account.id}`)
      }
      if (current.accounts.some((candidate) => candidate.token === account.token)) {
        throw new CredentialStoreError("Account credential already exists")
      }
      return { ...current, accounts: [...current.accounts, account] }
    })
    return account
  }

  async importFile(sourcePath: string): Promise<AccountFile> {
    let parsed: unknown
    try {
      parsed = JSON.parse(await readFile(sourcePath, "utf8"))
    } catch (error) {
      throw new CredentialStoreError("Invalid account credentials", { cause: error })
    }
    return await this.replace(parsed)
  }

  async mutate(
    update: (current: AccountFile) => AccountFile | Promise<AccountFile>,
  ): Promise<AccountFile> {
    return await this.#update(update)
  }

  async #update(
    update: (current: AccountFile) => AccountFile | Promise<AccountFile>,
  ): Promise<AccountFile> {
    return await withPathLock(this.#path, async () => {
      let result = emptyAccountFile()
      const operation = this.#queue.then(async () => {
        const current = await this.load()
        result = parseAccountFile(await update(current))
        await this.#write(result)
      })
      this.#queue = operation.then(
        () => undefined,
        () => undefined,
      )
      await operation
      return result
    })
  }

  async #write(value: AccountFile): Promise<void> {
    const directory = dirname(this.#path)
    const temporaryPath = `${this.#path}.${randomUUID()}.tmp`
    await mkdir(directory, { recursive: true, mode: 0o700 })
    const handle = await open(temporaryPath, "wx", 0o600)
    try {
      try {
        await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8")
        await handle.sync()
      } catch (writeError) {
        await rm(temporaryPath, { force: true })
        throw writeError
      } finally {
        await handle.close()
      }
      try {
        await rename(temporaryPath, this.#path)
        await chmod(this.#path, 0o600)
      } catch (error) {
        await rm(temporaryPath, { force: true })
        throw error
      }
    } catch (error) {
      // Best-effort: ensure no orphaned temp file survives any failure path.
      await rm(temporaryPath, { force: true }).catch(() => undefined)
      throw error
    }
  }
}
