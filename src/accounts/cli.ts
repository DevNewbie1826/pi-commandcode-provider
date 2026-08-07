import { pathToFileURL } from "node:url"

import { AccountPool } from "./pool.ts"
import { AccountStore, CredentialStoreError, defaultAccountStorePath } from "./store.ts"

function required(value: string | undefined, message: string): string {
  if (!value) throw new CredentialStoreError(message)
  return value
}

function tokenOption(args: readonly string[]): string {
  const index = args.indexOf("--token")
  return required(index < 0 ? undefined : args[index + 1], "Missing --token")
}

export async function runAccountsCli(
  args: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): Promise<number> {
  const store = new AccountStore(env.COMMANDCODE_ACCOUNTS_FILE ?? defaultAccountStorePath())
  const command = required(args[0], "Usage: accounts <add|import|list|next|remove>")

  if (command === "add") {
    const id = required(args[1], "Missing account id")
    await store.add({
      id,
      token: tokenOption(args),
      enabled: true,
      createdAt: new Date().toISOString(),
    })
    process.stdout.write(`${id}\n`)
    return 0
  }

  if (command === "import") {
    const sourcePath = required(args[1], "Missing import path")
    const imported = await store.importFile(sourcePath)
    process.stdout.write(`Imported ${imported.accounts.length} accounts\n`)
    return 0
  }

  if (command === "list") {
    const current = await store.load()
    for (const account of current.accounts) {
      const state =
        account.retryAt !== undefined && account.retryAt > Date.now() ? "quarantined" : "ready"
      process.stdout.write(`${account.id}\t${state}\n`)
    }
    return 0
  }

  if (command === "next") {
    const lease = await new AccountPool(store).next()
    process.stdout.write(`${lease.id}\n`)
    return 0
  }

  if (command === "remove") {
    const id = required(args[1], "Missing account id")
    await store.mutate(async (current) => ({
      ...current,
      accounts: current.accounts.filter((account) => account.id !== id),
    }))
    process.stdout.write(`${id}\n`)
    return 0
  }

  throw new CredentialStoreError(`Unknown account command: ${command}`)
}

async function main(): Promise<void> {
  try {
    process.exitCode = await runAccountsCli(process.argv.slice(2))
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    process.stderr.write(`${message}\n`)
    process.exitCode = 1
  }
}

const entrypoint = process.argv[1]
if (entrypoint && import.meta.url === pathToFileURL(entrypoint).href) {
  await main()
}
