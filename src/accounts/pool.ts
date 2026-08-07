import type { ApiKeyLease, ApiKeyResolver } from "../types.ts"
import type { AccountRecord } from "./schema.ts"
import { MAX_DATE_MS } from "./schema.ts"
import { AccountStore } from "./store.ts"

export class NoHealthyAccountsError extends Error {
  readonly retryAt: number | undefined

  constructor(retryAt?: number) {
    super(
      retryAt === undefined
        ? "No healthy Command Code accounts"
        : `No healthy Command Code accounts until ${new Date(retryAt).toISOString()}`,
    )
    this.name = "NoHealthyAccountsError"
    this.retryAt = retryAt
  }
}

function isHealthy(account: AccountRecord, now: number, excluded: ReadonlySet<string>): boolean {
  return (
    account.enabled &&
    !excluded.has(account.id) &&
    (account.retryAt === undefined || account.retryAt <= now)
  )
}

export class AccountPool {
  readonly #store: AccountStore
  readonly #now: () => number
  readonly #sessions = new Map<string, string>()

  constructor(store: AccountStore, now: () => number = Date.now) {
    this.#store = store
    this.#now = now
  }

  async next(sessionId?: string, excluded: ReadonlySet<string> = new Set()): Promise<ApiKeyLease> {
    let selected: AccountRecord | undefined

    await this.#store.mutate(async (current) => {
      const now = this.#now()
      const healthy = current.accounts.filter((account) => isHealthy(account, now, excluded))
      const stickyId = sessionId === undefined ? undefined : this.#sessions.get(sessionId)
      selected = healthy.find((account) => account.id === stickyId)

      if (!selected && healthy.length > 0) {
        selected = healthy[current.cursor % healthy.length]
      }
      if (!selected) {
        const retryAt = current.accounts
          .filter((account) => account.enabled)
          .map((account) => account.retryAt)
          .filter((value): value is number => value !== undefined && value > now)
          .sort((left, right) => left - right)[0]
        throw new NoHealthyAccountsError(retryAt)
      }

      if (sessionId !== undefined) this.#sessions.set(sessionId, selected.id)
      return { ...current, cursor: current.cursor + 1 }
    })

    if (!selected) throw new NoHealthyAccountsError()
    const account = selected
    return {
      id: account.id,
      token: account.token,
      quarantine: async (retryAt) => {
        await this.quarantine(account.id, retryAt)
      },
    }
  }

  async quarantine(accountId: string, retryAt: number): Promise<void> {
    const deadline = Math.min(retryAt, MAX_DATE_MS)
    await this.#store.mutate(async (current) => ({
      ...current,
      accounts: current.accounts.map((account) =>
        account.id === accountId
          ? {
              ...account,
              retryAt:
                account.retryAt === undefined ? deadline : Math.max(account.retryAt, deadline),
            }
          : account,
      ),
    }))
    for (const [sessionId, selectedId] of this.#sessions) {
      if (selectedId === accountId) this.#sessions.delete(sessionId)
    }
  }

  resolver(sessionId?: string): ApiKeyResolver {
    const excluded = new Set<string>()
    return async () => {
      const lease = await this.next(sessionId, excluded)
      excluded.add(lease.id)
      return lease
    }
  }
}
